import { HttpError } from "../connectors/http.js";
import type { CloudWatch } from "./store.js";
import type { WatchConfig } from "../config/schema.js";
import type { Evaluation } from "../pricing/score.js";
import type { Listing, Normalized } from "../config/schema.js";
export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string }; permissions?: string };
  user?: { id: string };
  data?: any;
}
export interface Message {
  content?: string;
  embeds?: any[];
  components?: any[];
  files?: { name: string; content: string }[];
}
const clean = (s: string) =>
  s.replace(/([\\*_`~|<>])/g, "\\$1").replace(/@/g, "＠");
const money = (n: number) => `$${n.toFixed(2)}`;
export function actor(i: Interaction) {
  const id = i.member?.user.id ?? i.user?.id;
  if (!id) throw new Error("Missing Discord user");
  return id;
}
export function options(i: Interaction): Record<string, any> {
  const root = i.data?.options ?? [];
  const sub = root.find((o: any) => o.type === 1);
  return Object.fromEntries(
    (sub?.options ?? root).map((o: any) => [o.name, o.value]),
  );
}
export function subcommand(i: Interaction): string {
  return i.data?.options?.find((o: any) => o.type === 1)?.name ?? "";
}
export function canPost(
  guild: any,
  channel: any,
  member: any,
  userId: string,
  required: bigint,
): boolean {
  if (guild.owner_id === userId) return true;
  const roles = new Set<string>([guild.id, ...(member.roles ?? [])]);
  let permissions = (guild.roles ?? [])
    .filter((r: any) => roles.has(r.id))
    .reduce((p: bigint, r: any) => p | BigInt(r.permissions), 0n);
  if (permissions & 8n) return true;
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((o: any) => o.id === guild.id);
  if (everyone)
    permissions =
      (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n,
    deny = 0n;
  for (const o of overwrites)
    if (o.type === 0 && o.id !== guild.id && roles.has(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  permissions = (permissions & ~deny) | allow;
  const user = overwrites.find((o: any) => o.type === 1 && o.id === userId);
  if (user)
    permissions = (permissions & ~BigInt(user.deny)) | BigInt(user.allow);
  return (permissions & required) === required;
}
export class DiscordHttp {
  constructor(
    private token: string,
    private appId: string,
    private signal?: AbortSignal,
  ) {}
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    files?: Message["files"],
  ) {
    let data: BodyInit | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
    };
    if (files?.length) {
      const form = new FormData();
      form.set(
        "payload_json",
        JSON.stringify({
          ...(body as object),
          attachments: files.map((f, id) => ({ id, filename: f.name })),
        }),
      );
      files.forEach((f, id) =>
        form.set(
          `files[${id}]`,
          new Blob([f.content], { type: "application/json" }),
          f.name,
        ),
      );
      data = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      data = JSON.stringify(body);
    }
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers,
      body: data,
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      let retry = 60000;
      if (r.status === 429) {
        try {
          retry = Math.max(1000, Number((await r.json()).retry_after) * 1000);
        } catch {}
      }
      throw new HttpError(r.status, Date.now() + retry, "discord");
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  async edit(i: Interaction, message: Message) {
    const { files, ...body } = message;
    return this.request(
      `/webhooks/${this.appId}/${encodeURIComponent(i.token)}/messages/@original`,
      "PATCH",
      { ...body, allowed_mentions: { parse: [] }, attachments: [] },
      files,
    );
  }
  async channelAllowed(id: string, guildId: string, userId: string) {
    const [guild, channel, member, me] = await Promise.all([
      this.request(`/guilds/${guildId}`),
      this.request(`/channels/${id}`),
      this.request(`/guilds/${guildId}/members/${userId}`),
      this.request("/users/@me"),
    ]);
    if (channel.guild_id !== guildId || channel.type !== 0)
      throw new Error("Choose a text channel in this server.");
    const botMember = await this.request(`/guilds/${guildId}/members/${me.id}`);
    const viewSend = (1n << 10n) | (1n << 11n);
    if (
      !canPost(guild, channel, member, userId, viewSend) ||
      !canPost(
        guild,
        channel,
        botMember,
        me.id,
        viewSend | (1n << 14n) | (1n << 15n),
      )
    )
      throw new Error(
        "You and the bot need channel access and Send Messages; the bot also needs Embed Links and Attach Files.",
      );
  }
  send(channel: string, message: Message, alertId: string) {
    return this.request(`/channels/${channel}/messages`, "POST", {
      ...message,
      allowed_mentions: { parse: [] },
      nonce: alertId.replaceAll("-", "").slice(0, 25),
      enforce_nonce: true,
    });
  }
}
export function preview(
  config: WatchConfig,
  id: string,
  notes: string[] = [],
): Message {
  return {
    content:
      [
        `**Review ${clean(config.name)}**`,
        `${clean(config.searchTerms)} · ${config.category} · US/USD`,
        `Conditions: ${config.conditions.join(", ")} · ${config.buying}`,
        `All-in budget: ${config.minAllIn ?? 0}–${config.maxAllIn ?? "no maximum"} USD`,
        ...(config.purpose === "match"
          ? [
              `Facebook Marketplace · asking price ≤ $${config.maxAskingPrice ?? "unlimited"}`,
              `Area: ${clean(config.location?.label ?? "unset")} · ${config.location?.radiusMiles} miles · ${config.deliveryModes?.join(" / ")}`,
              "Match-only watch: no sold prices, profit target, or resale analysis.",
              "Pending Bright Data connection — automatic discovery is NOT running.",
            ]
          : [
              `Minimum discount ${config.minDiscountPercent}% · profit ${money(config.minProfit)} · ${config.minComparables} verified sales`,
            ]),
        `Criteria: ${clean(config.constraints.map((c) => `${c.key} ${c.operator} ${c.value}`).join("; ") || "none")}`,
        ...notes
          .filter((n) => n.startsWith("Confirm recommendation:"))
          .map((n) => clean(n)),
        `Every ${config.intervalMinutes} minutes · <#${config.channelId}>`,
        ...notes
          .filter((n) => !n.startsWith("Confirm recommendation:"))
          .map((n) => clean(n)),
      ]
        .join("\n")
        .slice(0, 1600) +
      "\nRead the attached complete rules and fee assumptions. Confirm to save, or edit your query. Expires in 15 minutes.",
    files: [
      { name: "watch-preview.json", content: JSON.stringify(config, null, 2) },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Confirm watch",
            custom_id: `draft:create:${id}`,
          },
          {
            type: 2,
            style: 2,
            label: "Edit query",
            custom_id: `draft:edit:${id}`,
          },
          {
            type: 2,
            style: 4,
            label: "Cancel",
            custom_id: `draft:cancel:${id}`,
          },
        ],
      },
    ],
  };
}
export interface CloudAlert {
  listing: Listing;
  normalized: Normalized;
  evaluation: Evaluation;
  config: WatchConfig;
}
export function alertMessage(p: CloudAlert, id: string): Message {
  const { listing: l, normalized: n, evaluation: e } = p,
    m = e.metrics;
  if (!m) throw new Error("Missing pricing evidence");
  const evidence: string[] = [];
  for (const [i, c] of e.comparables.slice(0, 5).entries()) {
    const line = `[Sale ${i + 1}](<${new URL(c.sourceUrl).href}>) · ${money(c.salePrice + c.shipping)}`;
    if ([...evidence, line].join("\n").length > 800) break;
    evidence.push(line);
  }
  return {
    embeds: [
      {
        title: `${e.tier === "strong" ? "POTENTIAL DEAL" : "POSSIBLE MATCH"} · ${clean(l.title).slice(0, 200)}`,
        url: l.url,
        color: e.tier === "strong" ? 0x27ae60 : 0xe6a23c,
        description: clean(e.reasons.join("\n")).slice(0, 700),
        fields: [
          ...(l.source === "facebook_marketplace"
            ? [
                {
                  name: "Source / pickup",
                  value: `User-submitted Marketplace listing · manual · ${clean(l.provenance?.locationLabel ?? "unknown").slice(0, 200)} · travel ${money(m.travelCost ?? 0)}\nAsking price only; Tier 2 maximum. Verify in person.`,
                },
              ]
            : []),
          {
            name: l.auction ? "Current bid — provisional" : "Asking price",
            value: money(m.purchase),
            inline: true,
          },
          {
            name: "Inbound shipping",
            value: money(m.inboundShipping),
            inline: true,
          },
          { name: "Estimated all-in", value: money(m.allIn), inline: true },
          {
            name: "Acquisition costs",
            value: `Buyer fees ${money(m.buyerFees)} · estimated tax ${money(m.taxes)}${l.source === "facebook_marketplace" ? ` · travel ${money(m.travelCost ?? 0)} · risk reserve ${money(m.riskReserve)}` : ""}`,
          },
          {
            name: "Delivered-sale comparables",
            value: `Median ${money(m.median)} · range ${money(m.low)}–${money(m.high)}\n${m.count} verified sales · ${m.oldest.slice(0, 10)} to ${m.newest.slice(0, 10)}`,
          },
          {
            name: "Resale costs",
            value: `Selling fees ${money(m.sellingFees)} · outbound shipping ${money(m.outboundShipping)}${l.source === "ebay" ? ` · risk reserve ${money(m.riskReserve)}` : ""}`,
          },
          {
            name: "Net resale / estimated profit",
            value: `${money(m.netResale)} / ${money(m.profit)}`,
          },
          {
            name: "Discount / score",
            value: `${m.discountPercent}% / ${m.score}/100`,
            inline: true,
          },
          {
            name: "Modeled maximum purchase / bid",
            value: money(m.maxBid),
            inline: true,
          },
          {
            name: "Extraction confidence / condition",
            value: `${Math.round(n.confidence * 100)}% / ${n.condition}`,
            inline: true,
          },
          {
            name: "Identity / grade",
            value:
              clean(
                n.attributes.map((a) => `${a.key}: ${a.value}`).join(" · "),
              ).slice(0, 900) || "Unknown",
          },
          {
            name: "Seller / end time",
            value: `${clean(l.sellerName).slice(0, 100)} · ${l.sellerPercent ?? "unknown"}% · ${l.sellerFeedback ?? "unknown"} feedback\n${l.endTime ?? "End time not provided"}`,
          },
          {
            name: "Sale evidence",
            value: evidence.join("\n") || "Full links: /listing details",
          },
          {
            name: "Warnings",
            value: clean(
              [
                ...e.warnings,
                "Inspect original listing and photos. Authenticity is unverified.",
              ].join("\n"),
            ).slice(0, 900),
          },
        ],
        footer: {
          text: `Estimates are informational only. Verify authenticity, condition, fees, shipping, and comparable sales before bidding. Alert ${id}`,
        },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Open listing", url: l.url },
          ...["reviewed", "saved", "dismissed", "incorrect_match"].map(
            (a, i) => ({
              type: 2,
              style: 2,
              label: ["Reviewed", "Save", "Dismiss", "Not a match"][i],
              custom_id: `feedback:${a}:${id}`,
            }),
          ),
        ],
      },
    ],
  };
}
