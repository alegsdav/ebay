import { WatchConfig } from "../config/schema.js";
import {
  prepareWatch,
  describeDefaults,
  updateDefaults,
} from "../config/preferences.js";
import { feeDefaults } from "../config/env.js";
import { type Interpreter } from "../llm/client.js";
import { CloudStore, type CloudWatch } from "./store.js";
import {
  DiscordHttp,
  actor,
  options,
  subcommand,
  preview,
  type Interaction,
  type Message,
  alertMessage,
} from "./discord.js";
import type { CloudConfig } from "./config.js";
import { samplePayload } from "../fixtures.js";
import {
  manualDraft,
  manualPreview,
  evaluateManual,
  ManualDraft,
} from "../connectors/manual.js";
export function authorized(i: Interaction, c: CloudConfig) {
  if (
    i.application_id !== c.env.DISCORD_APPLICATION_ID ||
    i.guild_id !== c.env.DISCORD_GUILD_ID
  )
    throw new Error("This bot is restricted to its configured server.");
  const allow = c.env.ALLOWED_USER_IDS.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (allow.length && !allow.includes(actor(i)))
    throw new Error("Your account is not on the allowlist.");
}
export class CloudCommands {
  constructor(
    private db: CloudStore,
    private discord: DiscordHttp,
    private llm: Interpreter,
    private config: CloudConfig,
  ) {}
  async owned(id: string, i: Interaction) {
    const w = await this.db.watch(id, actor(i), i.guild_id!);
    if (!w) throw new Error("Watch not found or not owned by you.");
    return w;
  }
  async parse(
    i: Interaction,
    query: string,
    channel: string,
    watch?: CloudWatch,
    base?: WatchConfig,
  ) {
    if (!query || query.length > 2000)
      throw new Error("Use a query of 1–2000 characters.");
    const previous = base ?? watch?.config;
    const defaults = await this.db.defaults(actor(i), i.guild_id!);
    const parsed = await this.llm.parseWatch(query, defaults);
    const prepared = prepareWatch(
      parsed,
      query,
      channel,
      previous?.fees ?? feeDefaults(this.config.env),
      defaults,
      previous,
    );
    let config = prepared.config;
    if (previous)
      config = {
        ...config,
        channelId: previous.channelId,
        possibleChannelId: previous.possibleChannelId,
        intervalMinutes:
          config.purpose === "match"
            ? Math.max(1440, previous.intervalMinutes)
            : previous.intervalMinutes,
        minComparables: previous.minComparables,
        lookbackDays: previous.lookbackDays,
        minConfidence: previous.minConfidence,
      };
    if (config.buying !== "fixed" && !this.config.env.EBAY_ALLOW_AUCTIONS)
      throw new Error(
        "Auction access is disabled. Use fixed-price criteria until authorized auction access is configured.",
      );
    await this.discord.channelAllowed(config.channelId, i.guild_id!, actor(i));
    if (config.possibleChannelId)
      await this.discord.channelAllowed(
        config.possibleChannelId,
        i.guild_id!,
        actor(i),
      );
    const d = await this.db.createDraft(
      actor(i),
      i.guild_id!,
      config,
      prepared.editableQuery,
      i.id,
      watch,
    );
    return preview(d.config, d.id, [
      ...prepared.notes,
      ...parsed.assumptions,
      ...parsed.clarifications.map((q) => `Unresolved: ${q}`),
    ]);
  }
  async run(i: Interaction): Promise<Message> {
    authorized(i, this.config);
    const user = actor(i),
      guild = i.guild_id!;
    if (i.type === 3) {
      const [kind, action, id] = String(i.data.custom_id).split(":");
      if (!id) throw new Error("Invalid button");
      if (kind === "manual") {
        if (!["confirm", "cancel"].includes(action!))
          throw new Error("Invalid manual action");
        const draft = ManualDraft.parse(
          await this.db.rpc("scout_consume_submission", {
            p_id: id,
            p_owner: user,
            p_guild: guild,
          }),
        );
        if (action === "cancel")
          return { content: "Evaluation cancelled.", components: [] };
        const result = await evaluateManual(
          draft,
          this.llm,
          await this.db.comparables(
            draft.config.category,
            draft.config.lookbackDays,
          ),
        );
        await this.db.insert("scout_evaluations", {
          id,
          owner_id: user,
          guild_id: guild,
          data: result,
        });
        return {
          ...result,
          content: `${result.content}\nEvidence ID: ${id} (available with /listing details for 30 days).`,
        };
      }
      if (kind === "draft") {
        const d = await this.db.draft(id, user, guild);
        if (action === "cancel") {
          await this.db.remove("scout_drafts", {
            id: `eq.${id}`,
            owner_id: `eq.${user}`,
          });
          return { content: "Preview cancelled.", components: [] };
        }
        if (action !== "create") throw new Error("Unsupported draft action");
        await this.discord.channelAllowed(d.config.channelId, guild, user);
        if (d.config.possibleChannelId)
          await this.discord.channelAllowed(
            d.config.possibleChannelId,
            guild,
            user,
          );
        const watchId = await this.db.rpc("scout_confirm_draft", {
          p_id: id,
          p_owner: user,
          p_guild: guild,
        });
        return {
          content:
            d.config.purpose === "match"
              ? `Watch saved: \`${watchId}\`. Your criteria are confirmed. Facebook discovery is NOT running yet: Bright Data still needs to be connected. You do not need /listing evaluate.`
              : `Watch saved: \`${watchId}\`. ${this.config.CLOUD_MONITORING_ENABLED ? "Scheduled monitoring is enabled." : "Monitoring is OFF until you enable CLOUD_MONITORING_ENABLED."} ${this.config.env.DRY_RUN ? "Dry-run is ON; opportunity posts are suppressed." : ""}`,
          components: [],
        };
      }
      if (
        kind === "feedback" &&
        ["reviewed", "saved", "dismissed", "incorrect_match"].includes(action!)
      ) {
        await this.feedback(id, user, guild, action!);
        return { content: `Recorded: ${action}.` };
      }
      throw new Error("Unsupported button");
    }
    if (i.type === 5) {
      const id = String(i.data.custom_id).split(":")[1]!;
      const d = await this.db.draft(id, user, guild);
      const query = i.data.components
        ?.flatMap((r: any) => r.components ?? [])
        .find((c: any) => c.custom_id === "query")?.value;
      const result = await this.parse(
        i,
        query,
        d.config.channelId,
        d.watch_id ? await this.owned(d.watch_id, i) : undefined,
        d.config,
      );
      await this.db.remove("scout_drafts", {
        id: `eq.${id}`,
        owner_id: `eq.${user}`,
      });
      return result;
    }
    const opts = options(i),
      sub = subcommand(i),
      command = i.data.name;
    if (command === "defaults") {
      const previous = await this.db.defaults(user, guild);
      if (!Object.keys(opts).length)
        return { content: describeDefaults(previous) };
      const value = updateDefaults(previous, opts);
      await this.db.saveDefaults(user, guild, value);
      return { content: `Saved. ${describeDefaults(value)}` };
    }
    if (command === "watch") {
      if (sub === "create")
        return this.parse(i, opts.query, opts.channel ?? i.channel_id);
      if (sub === "list") {
        const rows = await this.db.rows("scout_watches", {
          owner_id: `eq.${user}`,
          guild_id: `eq.${guild}`,
          order: "created_at.desc",
          limit: "100",
        });
        return {
          content: rows.length
            ? rows
                .map(
                  (w) =>
                    `${w.active ? "Active" : "Paused"} · ${w.config.name} · \`${w.id}\``,
                )
                .join("\n")
                .slice(0, 1900)
            : "No watches. Use /watch create.",
          files: rows.length
            ? [{ name: "watches.json", content: JSON.stringify(rows, null, 2) }]
            : [],
        };
      }
      const w = await this.owned(opts.id, i);
      if (sub === "update")
        return this.parse(i, opts.query, w.config.channelId, w);
      if (sub === "delete") {
        await this.db.remove("scout_watches", {
          id: `eq.${w.id}`,
          owner_id: `eq.${user}`,
        });
        return { content: "Watch deleted." };
      }
      if (!["pause", "resume"].includes(sub))
        throw new Error("Unknown watch command");
      await this.db.rpc("scout_set_active", {
        p_id: w.id,
        p_owner: user,
        p_guild: guild,
        p_active: sub === "resume",
      });
      return { content: `Watch ${sub === "pause" ? "paused" : "resumed"}.` };
    }
    if (command === "settings") {
      const w = await this.owned(opts.id, i),
        config = { ...w.config };
      const keys = {
        discount: "minDiscountPercent",
        profit: "minProfit",
        confidence: "minConfidence",
        comparables: "minComparables",
        lookback: "lookbackDays",
        frequency: "intervalMinutes",
      } as const;
      for (const [name, key] of Object.entries(keys))
        if (opts[name] !== undefined) config[key] = opts[name];
      if (config.purpose === "match" && config.intervalMinutes < 1440)
        throw new Error(
          "Free-tier Marketplace searches run at most once daily (1440 minutes).",
        );
      config.channelId = opts.channel ?? config.channelId;
      config.possibleChannelId = opts.disable_possible
        ? null
        : (opts.possible_channel ?? config.possibleChannelId);
      await this.discord.channelAllowed(config.channelId, guild, user);
      if (config.possibleChannelId)
        await this.discord.channelAllowed(
          config.possibleChannelId,
          guild,
          user,
        );
      const d = await this.db.createDraft(
        user,
        guild,
        WatchConfig.parse(config),
        config.rawQuery,
        i.id,
        w,
      );
      return preview(d.config, d.id);
    }
    if (command === "listing") {
      if (sub === "evaluate") {
        const watch = await this.owned(opts.watch, i);
        const { watch: _watch, ...input } = opts;
        const draft = await manualDraft(input, watch.config);
        const row = await this.db.createSubmission(user, guild, i.id, draft);
        return manualPreview(ManualDraft.parse(row.data), row.id);
      }
      if (sub === "saved") {
        const rows = await this.db.rows("scout_feedback", {
          user_id: `eq.${user}`,
          action: "eq.saved",
          select: "alert_id",
          limit: "100",
        });
        const saved = [];
        for (const r of rows) {
          const a = await this.alert(r.alert_id, user, guild);
          if (a) saved.push(a);
        }
        return {
          content: `${saved.length} saved alerts.`,
          files: [
            {
              name: "saved-alerts.json",
              content: JSON.stringify(saved, null, 2),
            },
          ],
        };
      }
      if (sub === "details") {
        const result = (
          await this.db.rows("scout_evaluations", {
            id: `eq.${opts.alert}`,
            owner_id: `eq.${user}`,
            guild_id: `eq.${guild}`,
            expires_at: `gt.${new Date().toISOString()}`,
          })
        )[0];
        if (result) return result.data;
      }
      const a = await this.alert(opts.alert, user, guild);
      if (!a) throw new Error("Alert not found or not owned by you.");
      if (sub === "dismiss") {
        await this.feedback(opts.alert, user, guild, "dismissed");
        return { content: "Dismissed." };
      }
      return {
        content: `Delivery status: ${a.status}`,
        files: [
          {
            name: "alert-evidence.json",
            content: JSON.stringify(a.payload, null, 2),
          },
        ],
      };
    }
    if (command === "stats") {
      const watches = await this.db.rows("scout_watches", {
        owner_id: `eq.${user}`,
        guild_id: `eq.${guild}`,
        select: "id,active",
        limit: "1000",
      });
      return {
        content: `${watches.length} watches · ${watches.filter((w) => w.active).length} active. Dry-run: ${this.config.env.DRY_RUN}. Monitoring: ${this.config.CLOUD_MONITORING_ENABLED}. Facebook discovery: not connected. Marketplace cap: 10 active watches, daily minimum interval. No Bright Data calls are being made.`,
      };
    }
    if (command === "alert")
      return {
        ...alertMessage(samplePayload(), "synthetic-demo"),
        content: "SYNTHETIC TEST — fabricated example, not a real opportunity.",
        components: [],
      };
    throw new Error("Unknown command");
  }
  async alert(id: string, user: string, guild: string) {
    const a = (await this.db.rows("scout_alerts", { id: `eq.${id}` }))[0];
    if (!a || !(await this.db.watch(a.watch_id, user, guild))) return null;
    return a;
  }
  async feedback(id: string, user: string, guild: string, action: string) {
    if (!(await this.alert(id, user, guild)))
      throw new Error("Alert not found or not owned by you.");
    await this.db.upsert(
      "scout_feedback",
      {
        alert_id: id,
        user_id: user,
        action,
        updated_at: new Date().toISOString(),
      },
      "alert_id,user_id",
    );
  }
}
