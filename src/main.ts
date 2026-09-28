import { REST, Routes } from "discord.js";
import { getEnv, requireValues } from "./config/env.js";
import { commands } from "./commands/definitions.js";
import { log, errorKind } from "./logging.js";
// The bot runs on Supabase Edge Functions; locally we only register slash commands.
async function main() {
  const mode = process.argv[2] ?? "register";
  if (mode !== "register") throw new Error("Usage: register");
  const env = getEnv();
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
