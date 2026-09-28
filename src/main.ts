import { readFileSync } from "node:fs";
import { REST, Routes } from "discord.js";
import { getEnv, requireValues } from "./config/env.js";
import { Store } from "./database/store.js";
import { LlmClient } from "./llm/client.js";
import { EbaySource } from "./connectors/ebay.js";
import { DiscordBot, DiscordSink } from "./commands/bot.js";
import { commands } from "./commands/definitions.js";
import { Pipeline } from "./scheduler/pipeline.js";
import { log, errorKind } from "./logging.js";
async function main() {
  const mode = process.argv[2] ?? "start";
  const env = getEnv();
  if (mode === "register") {
    requireValues(env, [
      "DISCORD_TOKEN",
      "DISCORD_APPLICATION_ID",
      "DISCORD_GUILD_ID",
    ]);
    await new REST({ version: "10" })
      .setToken(env.DISCORD_TOKEN)
      .put(
        Routes.applicationGuildCommands(
          env.DISCORD_APPLICATION_ID,
          env.DISCORD_GUILD_ID,
        ),
        { body: commands },
      );
    log("commands_registered");
    return;
  }
  if (!["start", "scan", "import"].includes(mode))
    throw new Error("Usage: start | scan | import <json-file>");
  const store = new Store(env.DATABASE_PATH);
  if (mode === "import") {
    try {
      const path = process.argv[3];
      if (!path)
        throw new Error("Usage: npm run import:comparables -- sales.json");
      const count = store.importComparables(
        JSON.parse(readFileSync(path, "utf8")),
      );
      log("comparables_imported", { count });
    } finally {
      store.close();
    }
    return;
  }
  const llm = new LlmClient(env, () =>
    store.consumeBudget("llm", env.MAX_LLM_CALLS_PER_DAY),
  );
  const source = new EbaySource(env, () =>
    store.consumeBudget("ebay", env.EBAY_MAX_CALLS_PER_DAY),
  );
  let bot: DiscordBot | undefined;
  if (mode === "start" || !env.DRY_RUN) {
    requireValues(env, ["DISCORD_TOKEN", "DISCORD_GUILD_ID"]);
    bot = new DiscordBot(store, llm, env);
    await bot.login();
  }
  const sink = bot
    ? new DiscordSink(bot.client)
    : {
        async send() {
          throw new Error("Dry-run cannot send");
        },
      };
  const pipeline = new Pipeline(store, source, llm, sink, {
    dryRun: env.DRY_RUN,
    maxLlmCalls: env.MAX_LLM_CALLS_PER_SCAN,
  });
  if (mode === "scan") {
    try {
      await pipeline.run(true);
    } finally {
      bot?.client.destroy();
      store.close();
    }
    return;
  }
  let running: Promise<void> | null = null;
  const tick = () => {
    if (!running)
      running = pipeline
        .run()
        .catch((e) => log("scheduler_failure", { error: errorKind(e) }))
        .finally(() => {
          running = null;
        });
  };
  tick();
  const timer = setInterval(tick, 60 * 60000);
  const stop = async () => {
    clearInterval(timer);
    bot?.client.destroy();
    if (running) await running;
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  log("bot_started", { dryRun: env.DRY_RUN, intervalMinutes: 60 });
}
main().catch((error) => {
  log("startup_failure", {
    error: errorKind(error),
    message:
      error instanceof Error && error.name === "Error"
        ? error.message
        : "Check configuration and credentials",
  });
  process.exitCode = 1;
});
