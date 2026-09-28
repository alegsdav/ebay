import { WatchConfig } from "../config/schema.js";
import {
  prepareWatch,
  describeDefaults,
  updateDefaults,
  sourceChoices,
  sourceLabel,
  marketplaceMinInterval,
  type SourceChoice,
} from "../config/preferences.js";
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
  feedbackActions,
} from "./discord.js";
import type { CloudConfig } from "./config.js";
import { samplePayload } from "../fixtures.js";
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
    sources?: string,
  ) {
    if (!query || query.length > 2000)
      throw new Error("Use a query of 1–2000 characters.");
    if (sources !== undefined && !Object.hasOwn(sourceChoices, sources))
      throw new Error("Unsupported sources option.");
    const previous = base ?? watch?.config;
    const defaults = await this.db.defaults(actor(i), i.guild_id!);
    const parsed = await this.llm.parseWatch(query, defaults);
    const prepared = prepareWatch(
      parsed,
      query,
      channel,
      defaults,
      previous,
      sources as SourceChoice | undefined,
    );
    const config = prepared.config;
    if (config.buying !== "fixed" && !this.config.env.EBAY_ALLOW_AUCTIONS)
      throw new Error(
        "Auction access is disabled. Use fixed-price criteria until authorized auction access is configured.",
      );
    await this.discord.channelAllowed(config.channelId, i.guild_id!, actor(i));
    const d = await this.db.createDraft(
      actor(i),
      i.guild_id!,
      config,
      prepared.editableQuery,
      i.id,
      watch,
    );
    return preview(
      d.config,
      d.id,
      [
        ...prepared.notes,
        ...parsed.assumptions,
        ...parsed.clarifications.map((q) => `Unresolved: ${q}`),
      ],
      this.config.env.FACEBOOK_MONITORING_ENABLED,
    );
  }
  async run(i: Interaction): Promise<Message> {
    authorized(i, this.config);
    const user = actor(i),
      guild = i.guild_id!;
    if (i.type === 3) {
      const [kind, action, id] = String(i.data.custom_id).split(":");
      if (!id) throw new Error("Invalid button");
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
        const watchId = await this.db.rpc("scout_confirm_draft", {
          p_id: id,
          p_owner: user,
          p_guild: guild,
        });
        const facebookPending =
          d.config.sources.includes("facebook_marketplace") &&
          !this.config.env.FACEBOOK_MONITORING_ENABLED;
        return {
          content: [
            `Watch saved: \`${watchId}\`. Sources: ${d.config.sources.map(sourceLabel).join(" + ")}.`,
            this.config.CLOUD_MONITORING_ENABLED
              ? "Scheduled monitoring is enabled."
              : "Monitoring is OFF until you enable CLOUD_MONITORING_ENABLED.",
            ...(facebookPending
              ? [
                  "Facebook Marketplace searching is turned off right now; that leg is skipped until it is enabled.",
                ]
              : []),
            ...(this.config.env.DRY_RUN
              ? ["Dry-run is ON; match posts are suppressed."]
              : []),
          ].join(" "),
          components: [],
        };
      }
      // incorrect_match is the pre-rework label on older alert buttons.
      const feedback = action === "incorrect_match" ? "not_relevant" : action!;
      if (kind === "feedback" && Object.hasOwn(feedbackActions, feedback)) {
        await this.feedback(id, user, guild, feedback);
        return {
          content: `Recorded: ${feedbackActions[feedback as keyof typeof feedbackActions]}.`,
        };
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
      // Marketplace searches by city; look up the city for a ZIP once, at save time.
      if (value.location.postalCode && !value.location.city)
        value.location.city = await this.llm
          .resolveCity?.(value.location.postalCode)
          .catch(() => null);
      await this.db.saveDefaults(user, guild, value);
      return { content: `Saved. ${describeDefaults(value)}` };
    }
    if (command === "watch") {
      if (sub === "create")
        return this.parse(
          i,
          opts.query,
          opts.channel ?? i.channel_id,
          undefined,
          undefined,
          opts.sources,
        );
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
                    `${w.active ? "Active" : "Paused"} · ${w.config.name} · ${(w.config.sources ?? []).map(sourceLabel).join(" + ")} · \`${w.id}\``,
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
        return this.parse(
          i,
          opts.query,
          w.config.channelId,
          w,
          undefined,
          opts.sources,
        );
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
      if (opts.clear_price_limits) {
        config.minPrice = null;
        config.maxPrice = null;
      }
      if (opts.min_price !== undefined) config.minPrice = opts.min_price;
      if (opts.max_price !== undefined) config.maxPrice = opts.max_price;
      if (
        config.minPrice !== null &&
        config.maxPrice !== null &&
        config.minPrice > config.maxPrice
      )
        throw new Error("Minimum price exceeds maximum price.");
      if (opts.frequency !== undefined) config.intervalMinutes = opts.frequency;
      if (
        config.sources.includes("facebook_marketplace") &&
        config.intervalMinutes < marketplaceMinInterval
      )
        throw new Error(
          "Watches that include Facebook Marketplace run at most hourly (60 minutes).",
        );
      config.channelId = opts.channel ?? config.channelId;
      await this.discord.channelAllowed(config.channelId, guild, user);
      const d = await this.db.createDraft(
        user,
        guild,
        WatchConfig.parse(config),
        config.rawQuery,
        i.id,
        w,
      );
      return preview(
        d.config,
        d.id,
        [],
        this.config.env.FACEBOOK_MONITORING_ENABLED,
      );
    }
    if (command === "listing") {
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
        content: `${watches.length} watches · ${watches.filter((w) => w.active).length} active. Dry-run: ${this.config.env.DRY_RUN}. Monitoring: ${this.config.CLOUD_MONITORING_ENABLED}. Facebook Marketplace: ${this.config.env.FACEBOOK_MONITORING_ENABLED ? "enabled" : "disabled"}. Watches that include Marketplace: at most 5 active; up to ${this.config.env.BRIGHT_DATA_MAX_RECORDS_PER_MONTH} Bright Data records per month.`,
      };
    }
    if (command === "alert")
      return {
        ...alertMessage(samplePayload(), "synthetic-demo"),
        content: "SYNTHETIC TEST — fabricated example, not a real listing.",
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
