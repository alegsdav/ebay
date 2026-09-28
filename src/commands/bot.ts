import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type Interaction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { Store } from "../database/store.js";
import { type Env, feeDefaults } from "../config/env.js";
import { templates } from "../config/categories.js";
import {
  prepareWatch,
  describeDefaults,
  updateDefaults,
} from "../config/preferences.js";
import { preview as cloudPreview } from "../cloud/discord.js";
import { WatchConfig, type Watch } from "../config/schema.js";
import type { Interpreter } from "../llm/client.js";
import { formatAlert, type AlertPayload } from "../alerts/format.js";
import type { AlertSink } from "../scheduler/pipeline.js";
import { log, errorKind } from "../logging.js";
import { samplePayload } from "../fixtures.js";
import {
  manualDraft,
  manualPreview,
  evaluateManual,
  ManualDraft,
} from "../connectors/manual.js";
import type { Message } from "../cloud/discord.js";
const localMessage = ({ files, ...body }: Message) => ({
  ...body,
  files: files?.map(
    (f) => new AttachmentBuilder(Buffer.from(f.content), { name: f.name }),
  ),
  allowedMentions: { parse: [] as [] },
});
const clean = (s: string) => escapeMarkdown(s).replace(/@/g, "＠");
export function preview(config: WatchConfig, id: string, notes: string[] = []) {
  if (config.purpose === "match")
    return localMessage(cloudPreview(config, id, notes));
  const full = JSON.stringify(config, null, 2);
  const summary = [
    `**Review watch: ${clean(config.name)}**`,
    `Category: ${templates[config.category].name} · US / USD`,
    `Search: ${clean(config.searchTerms)}`,
    `Conditions: ${config.conditions.join(", ")} · format: ${config.buying}`,
    `All-in budget: ${config.minAllIn ?? 0}–${config.maxAllIn ?? "no maximum"} USD`,
    `Deal thresholds: ${config.minDiscountPercent}% discount · $${config.minProfit} profit · ${config.minComparables} verified sales / ${config.lookbackDays} days`,
    `Seller ≥ ${config.minSellerPercent}% · extraction confidence ≥ ${config.minConfidence}`,
    `Alerts: <#${config.channelId}> · possible matches: ${config.possibleChannelId ? `<#${config.possibleChannelId}>` : "stored silently"} · every ${config.intervalMinutes} minutes`,
    `Fees: tax ${config.fees.taxRate * 100}%; buyer ${config.fees.buyerRate * 100}% + $${config.fees.buyerFixed}; selling ${config.fees.sellingRate * 100}% + $${config.fees.sellingFixed}; outbound $${config.fees.outboundShipping}; risk ${config.fees.riskRate * 100}%`,
    `Required attributes: ${clean(config.constraints.map((c) => `${c.key} ${c.operator} ${c.value}`).join("; ") || "none")}`,
    `Exclusions: ${clean(config.excludedKeywords.join(", "))}`,
    ...notes.map((n) => `• ${clean(n)}`),
  ].join("\n");
  return {
    content:
      summary.slice(0, 1800) +
      "\nReview the attached full configuration. Confirm to save. Preview expires in 15 minutes.",
    files: [
      new AttachmentBuilder(Buffer.from(full), { name: "watch-preview.json" }),
    ],
    allowedMentions: { parse: [] as [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`draft:create:${id}`)
          .setLabel("Confirm watch")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`draft:edit:${id}`)
          .setLabel("Edit query")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`draft:cancel:${id}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}
export class DiscordSink implements AlertSink {
  constructor(private client: Client) {}
  async send(channelId: string, payload: AlertPayload, id: string) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable() || channel.isDMBased())
      throw new Error("Destination is not a guild message channel");
    const message = await channel.send({
      ...formatAlert(payload, id),
      nonce: id.replaceAll("-", "").slice(0, 25),
      enforceNonce: true,
    });
    return message.id;
  }
}
export class DiscordBot {
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
    rest: { retries: 0 },
  });
  private lastParse = new Map<string, number>();
  constructor(
    private store: Store,
    private llm: Interpreter,
    private env: Env,
  ) {
    this.client.on(Events.InteractionCreate, (i) => {
      void this.handle(i);
    });
    this.client.on(Events.Error, () => log("discord_client_error"));
  }
  async login() {
    await this.client.login(this.env.DISCORD_TOKEN);
    if (!this.client.isReady())
      await new Promise<void>((r) =>
        this.client.once(Events.ClientReady, () => r()),
      );
  }
  private authorize(i: Interaction) {
    const ids = this.env.ALLOWED_USER_IDS.split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!i.guildId || i.guildId !== this.env.DISCORD_GUILD_ID)
      throw new Error("This bot is restricted to its configured server.");
    if (ids.length && !ids.includes(i.user.id))
      throw new Error("Your user ID is not on the bot allowlist.");
  }
  private owned(id: string, i: Interaction): Watch {
    const w = this.store.watch(id, i.user.id, i.guildId!);
    if (!w) throw new Error("Watch not found or not owned by you.");
    return w;
  }
  private async channelAllowed(id: string, i: Interaction) {
    const channel = await this.client.channels.fetch(id);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== i.guildId
    )
      throw new Error("Choose a text channel in this server.");
    const member = await channel.guild.members.fetch(i.user.id);
    const me = await channel.guild.members.fetchMe();
    if (
      !channel
        .permissionsFor(member)
        .has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
        ]) ||
      !channel
        .permissionsFor(me)
        .has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ])
    )
      throw new Error(
        "You and the bot need permission to post in the selected channel; the bot also needs Embed Links.",
      );
  }
  private async parse(
    i: ChatInputCommandInteraction | ModalSubmitInteraction,
    query: string,
    channelId: string,
    watch?: Watch,
    base?: WatchConfig,
  ) {
    const now = Date.now();
    if (now - (this.lastParse.get(i.user.id) ?? 0) < 15000)
      throw new Error(
        "Please wait 15 seconds between interpretation requests.",
      );
    this.lastParse.set(i.user.id, now);
    const defaults = this.store.defaults(i.user.id, i.guildId!);
    const parsed = await this.llm.parseWatch(query, defaults);
    const prepared = prepareWatch(
      parsed,
      query,
      channelId,
      watch?.config.fees ?? base?.fees ?? feeDefaults(this.env),
      defaults,
      base ?? watch?.config,
    );
    let config = prepared.config;
    const previous = base ?? watch?.config;
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
    if (config.buying !== "fixed" && !this.env.EBAY_ALLOW_AUCTIONS)
      throw new Error(
        "Auction monitoring is disabled for this deployment. Use fixed-price items until approved auction access is configured.",
      );
    await this.channelAllowed(config.channelId, i);
    if (config.possibleChannelId)
      await this.channelAllowed(config.possibleChannelId, i);
    const id = this.store.draft(
      i.user.id,
      i.guildId!,
      config,
      prepared.editableQuery,
      watch,
    );
    await i.editReply(
      preview(config, id, [
        ...prepared.notes,
        ...parsed.assumptions,
        ...parsed.clarifications.map((q) => `Unresolved — ${q}`),
        `Interpretation confidence: ${parsed.confidence}. Confirmation accepts the displayed defaults; edit if any ambiguity matters.`,
      ]),
    );
  }
  async handle(i: Interaction) {
    if (!i.isChatInputCommand() && !i.isButton() && !i.isModalSubmit()) return;
    try {
      this.authorize(i);
      if (i.isButton()) {
        const [kind, action, id] = i.customId.split(":");
        if (!id) throw new Error("Invalid action");
        if (kind === "manual") {
          if (!["confirm", "cancel"].includes(action!))
            throw new Error("Invalid manual action");
          const draft = ManualDraft.parse(
            this.store.consumeSubmission(id, i.user.id, i.guildId!),
          );
          await i.deferUpdate();
          if (action === "cancel")
            await i.editReply({
              content: "Evaluation cancelled.",
              components: [],
              attachments: [],
            });
          else {
            const result = await evaluateManual(
              draft,
              this.llm,
              this.store.comparables(draft.config.category),
            );
            this.store.saveEvaluation(id, i.user.id, i.guildId!, result);
            await i.editReply({
              ...localMessage(result),
              content: `${result.content}\nEvidence ID: ${id} (available with /listing details for 30 days).`,
              attachments: [],
            });
          }
          return;
        }
        if (kind === "draft") {
          const d = this.store.getDraft(id, i.user.id, i.guildId!);
          if (action === "edit") {
            const input = new TextInputBuilder()
              .setCustomId("query")
              .setLabel("Complete watch request")
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(2000)
              .setRequired(true)
              .setValue(d.query);
            await i.showModal(
              new ModalBuilder()
                .setCustomId(`edit:${id}`)
                .setTitle("Edit watch query")
                .addComponents(
                  new ActionRowBuilder<TextInputBuilder>().addComponents(input),
                ),
            );
            return;
          }
          await i.deferUpdate();
          if (action === "cancel") {
            this.store.cancelDraft(id, i.user.id, i.guildId!);
            await i.editReply({
              content: "Preview cancelled.",
              components: [],
              attachments: [],
            });
            return;
          }
          if (action !== "create") throw new Error("Invalid preview action");
          const config = WatchConfig.parse(JSON.parse(d.config));
          await this.channelAllowed(config.channelId, i);
          if (config.possibleChannelId)
            await this.channelAllowed(config.possibleChannelId, i);
          const watchId = this.store.confirmDraft(id, i.user.id, i.guildId!);
          await i.editReply({
            content:
              config.purpose === "match"
                ? `Watch saved: \`${watchId}\`. Facebook discovery is NOT running yet: Bright Data still needs to be connected. You do not need /listing evaluate.`
                : `Watch saved: \`${watchId}\`. Hourly scheduler will check when due.${this.env.DRY_RUN ? " Dry-run is ON; outgoing alerts are suppressed." : ""}`,
            components: [],
            attachments: [],
          });
          return;
        }
        if (
          kind === "feedback" &&
          ["reviewed", "saved", "dismissed", "incorrect_match"].includes(
            action ?? "",
          )
        ) {
          this.store.feedback(id, i.user.id, i.guildId!, action!);
          await i.reply({
            content: `Recorded: ${action!.replaceAll("_", " ")}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        throw new Error("Unsupported action");
      }
      if (i.isModalSubmit()) {
        const id = i.customId.split(":")[1];
        if (!id) throw new Error("Invalid edit");
        const d = this.store.getDraft(id, i.user.id, i.guildId!);
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const old = WatchConfig.parse(JSON.parse(d.config));
        const watch = d.watch_id ? this.owned(d.watch_id, i) : undefined;
        await this.parse(
          i,
          i.fields.getTextInputValue("query"),
          old.channelId,
          watch,
          old,
        );
        this.store.cancelDraft(id, i.user.id, i.guildId!);
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (i.commandName === "defaults") {
        const previous = this.store.defaults(i.user.id, i.guildId!);
        const opts = Object.fromEntries(
          i.options.data.map((o) => [o.name, o.value]),
        );
        if (!Object.keys(opts).length) {
          await i.editReply(describeDefaults(previous));
          return;
        }
        const value = updateDefaults(previous, opts);
        this.store.saveDefaults(i.user.id, i.guildId!, value);
        await i.editReply(`Saved. ${describeDefaults(value)}`);
        return;
      }
      if (i.commandName === "watch") {
        const sub = i.options.getSubcommand();
        if (sub === "create") {
          await this.parse(
            i,
            i.options.getString("query", true),
            i.options.getChannel("channel")?.id ?? i.channelId,
          );
          return;
        }
        if (sub === "list") {
          const watches = this.store.watches(i.user.id, i.guildId!);
          const content = watches
            .map(
              (w) =>
                `${w.active ? "Active" : "Paused"} · ${clean(w.config.name)}\n\`${w.id}\` · <#${w.config.channelId}>`,
            )
            .join("\n\n");
          await i.editReply({
            content:
              content.slice(0, 1950) || "No watches. Start with /watch create.",
            files: watches.length
              ? [
                  new AttachmentBuilder(
                    Buffer.from(JSON.stringify(watches, null, 2)),
                    { name: "watches.json" },
                  ),
                ]
              : [],
          });
          return;
        }
        const w = this.owned(i.options.getString("id", true), i);
        if (sub === "update") {
          await this.parse(
            i,
            i.options.getString("query", true),
            w.config.channelId,
            w,
          );
          return;
        }
        if (sub === "delete")
          this.store.deleteWatch(w.id, i.user.id, i.guildId!);
        else
          this.store.setActive(w.id, i.user.id, i.guildId!, sub === "resume");
        await i.editReply(
          `Watch ${sub === "delete" ? "deleted" : sub === "resume" ? "resumed" : "paused"}.`,
        );
        return;
      }
      if (i.commandName === "settings") {
        const w = this.owned(i.options.getString("id", true), i);
        const config = { ...w.config };
        const mapping = {
          discount: "minDiscountPercent",
          profit: "minProfit",
          confidence: "minConfidence",
          comparables: "minComparables",
          lookback: "lookbackDays",
          frequency: "intervalMinutes",
        } as const;
        for (const [option, key] of Object.entries(mapping)) {
          const value = i.options.get(option)?.value;
          if (typeof value === "number") config[key] = value;
        }
        config.channelId =
          i.options.getChannel("channel")?.id ?? config.channelId;
        config.possibleChannelId = i.options.getBoolean("disable_possible")
          ? null
          : (i.options.getChannel("possible_channel")?.id ??
            config.possibleChannelId);
        await this.channelAllowed(config.channelId, i);
        if (config.possibleChannelId)
          await this.channelAllowed(config.possibleChannelId, i);
        const id = this.store.draft(
          i.user.id,
          i.guildId!,
          WatchConfig.parse(config),
          config.rawQuery,
          w,
        );
        await i.editReply(preview(config, id));
        return;
      }
      if (i.commandName === "listing") {
        if (i.options.getSubcommand() === "evaluate") {
          const w = this.owned(i.options.getString("watch", true), i);
          const input = Object.fromEntries(
            i.options.data[0]!.options!.filter((o) => o.name !== "watch").map(
              (o) => [o.name, o.value],
            ),
          );
          const draft = await manualDraft(input, w.config);
          const id = this.store.createSubmission(i.user.id, i.guildId!, draft);
          await i.editReply(localMessage(manualPreview(draft, id)));
          return;
        }
        if (i.options.getSubcommand() === "saved") {
          const saved = this.store.savedAlerts(i.user.id, i.guildId!);
          await i.editReply({
            content: saved.length
              ? `${saved.length} saved alerts. Full evidence is attached.`
              : "No saved alerts yet.",
            files: saved.length
              ? [
                  new AttachmentBuilder(
                    Buffer.from(JSON.stringify(saved, null, 2)),
                    { name: "saved-alerts.json" },
                  ),
                ]
              : [],
          });
          return;
        }
        const id = i.options.getString("alert", true);
        if (i.options.getSubcommand() === "details") {
          const result = this.store.manualEvaluation(id, i.user.id, i.guildId!);
          if (result) {
            await i.editReply(localMessage(result));
            return;
          }
        }
        const a = this.store.alert(id);
        if (!a || a.owner_id !== i.user.id || a.guild_id !== i.guildId)
          throw new Error("Alert not found or not owned by you.");
        if (i.options.getSubcommand() === "dismiss") {
          this.store.feedback(id, i.user.id, i.guildId!, "dismissed");
          await i.editReply("Dismissed.");
        } else
          await i.editReply({
            content: `Saved alert evidence · delivery status: ${a.status}`,
            files: [
              new AttachmentBuilder(Buffer.from(a.payload), {
                name: "alert-evidence.json",
              }),
            ],
          });
        return;
      }
      if (i.commandName === "stats") {
        await i.editReply(
          "```json\n" +
            JSON.stringify(this.store.stats(i.user.id, i.guildId!), null, 2) +
            "\n```",
        );
        return;
      }
      if (i.commandName === "alert") {
        const sample = formatAlert(samplePayload(), "synthetic-demo");
        await i.editReply({
          ...sample,
          content:
            "SYNTHETIC TEST — fabricated example, not an actual listing or sale.",
          components: [],
        });
        return;
      }
    } catch (error) {
      log("interaction_failure", { error: errorKind(error) });
      // Provider bodies/tokens never reach Discord. Only application validation messages are displayed.
      const message =
        error instanceof Error && error.name === "Error"
          ? error.message
          : "Request failed validation or a provider failed. Check structured logs and try again.";
      if (i.deferred || i.replied)
        await i
          .editReply({ content: clean(message).slice(0, 1900), components: [] })
          .catch(() => {});
      else
        await i
          .reply({
            content: clean(message).slice(0, 1900),
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
    }
  }
}
