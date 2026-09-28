import { HttpError } from "../connectors/http.js";
import type { Listing, Normalized, WatchConfig } from "../config/schema.js";
import type { MatchResult } from "../filters/evaluate.js";
import { sourceLabel, marketplaceCity } from "../config/preferences.js";
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
const priceRange = (w: WatchConfig) =>
  w.minPrice === null && w.maxPrice === null
    ? "any price"
    : w.minPrice === null
      ? `up to ${money(w.maxPrice!)}`
      : w.maxPrice === null
        ? `${money(w.minPrice)} or more`
        : `${money(w.minPrice)}–${money(w.maxPrice)}`;
export function preview(
  config: WatchConfig,
  id: string,
  notes: string[] = [],
  facebookEnabled = false,
): Message {
  const marketplace = config.sources.includes("facebook_marketplace");
  return {
    content:
      [
        `**Review ${clean(config.name)}**`,
        `Keywords: ${clean(config.searchTerms)} · US/USD`,
        `Sources: ${config.sources.map(sourceLabel).join(" + ")}`,
        `Price: ${priceRange(config)} · conditions ${config.conditions.join(", ")} · ${config.buying}`,
        `Excluding: ${clean(config.excludedKeywords.join(", ") || "none")}`,
        `Criteria: ${clean(config.constraints.map((c) => `${c.key} ${c.operator} ${c.value}`).join("; ") || "none")}`,
        ...(config.minSellerPercent !== null
          ? [`eBay seller rating ≥ ${config.minSellerPercent}%`]
          : []),
        ...(marketplace
          ? [
              `Marketplace: near ${clean((config.location && marketplaceCity(config.location)) ?? "unset")} · ${config.location?.radiusMiles} miles · ${config.deliveryModes?.join(" / ")}`,
              "Marketplace: first check shows current listings; later checks look for newly listed ones.",
              ...(facebookEnabled
                ? []
                : [
                    "Facebook Marketplace searching is turned off right now; that leg is skipped until it is enabled.",
                  ]),
            ]
          : []),
        ...notes
          .filter((n) => n.startsWith("Confirm recommendation:"))
          .map((n) => clean(n)),
        `Every ${config.intervalMinutes} minutes · alerts in <#${config.channelId}>`,
        ...notes
          .filter((n) => !n.startsWith("Confirm recommendation:"))
          .map((n) => clean(n)),
      ]
        .join("\n")
        .slice(0, 1600) +
      "\nMatching listings are posted once each; no price analysis. Read the attached rules. Confirm to save, or edit your query. Expires in 15 minutes.",
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
  match: MatchResult;
  config: WatchConfig;
}
export const feedbackActions = {
  reviewed: "Reviewed",
  saved: "Save",
  dismissed: "Dismiss",
  not_relevant: "Not relevant",
} as const;
export function alertMessage(p: CloudAlert, id: string): Message {
  const { listing: l, normalized: n, match: m, config: w } = p;
  const marketplace = l.source === "facebook_marketplace";
  const keys = new Set(w.constraints.map((c) => c.key));
  const shown = keys.size
    ? n.attributes.filter((a) => keys.has(a.key))
    : n.attributes;
  const shipping =
    l.shipping === null
      ? marketplace
        ? ""
        : " · shipping unknown"
      : l.shipping === 0
        ? " · free shipping"
        : ` + ${money(l.shipping)} shipping`;
  return {
    embeds: [
      {
        title: `MATCH · ${clean(l.title).slice(0, 200)}`,
        url: l.url,
        color: marketplace ? 0x1877f2 : 0xe53238,
        description: clean(n.explanation).slice(0, 700) || undefined,
        fields: [
          { name: "Source", value: sourceLabel(l.source), inline: true },
          {
            name: l.auction ? "Current bid — provisional" : "Price",
            value: `${money(l.price)}${shipping}`,
            inline: true,
          },
          {
            name: "Condition",
            value: l.condition === "unknown" ? n.condition : l.condition,
            inline: true,
          },
          {
            name: keys.size ? "Matched criteria" : "Details",
            value:
              clean(shown.map((a) => `${a.key}: ${a.value}`).join(" · ")).slice(
                0,
                900,
              ) || "None extracted",
          },
          ...(marketplace
            ? [
                {
                  name: "Location / pickup",
                  value: `${clean(l.provenance?.locationLabel ?? "unknown").slice(0, 200)} · ${l.provenance?.deliveryModes.join(" / ") ?? "pickup"}${w.estimatedTravelCost > 0 ? ` · your travel estimate ${money(w.estimatedTravelCost)}` : ""}`,
                },
              ]
            : [
                {
                  name: "Seller",
                  value: `${clean(l.sellerName).slice(0, 100)} · ${l.sellerPercent ?? "unknown"}% positive · ${l.sellerFeedback ?? "unknown"} feedback`,
                },
              ]),
          ...(l.listedAt
            ? [
                {
                  name: "Listed",
                  value: `<t:${Math.floor(Date.parse(l.listedAt) / 1000)}:R>`,
                  inline: true,
                },
              ]
            : []),
          ...(l.auction
            ? [
                {
                  name: "Ends",
                  value: l.endTime
                    ? `<t:${Math.floor(Date.parse(l.endTime) / 1000)}:R>`
                    : "End time not provided",
                  inline: true,
                },
              ]
            : []),
          {
            name: "Warnings",
            value: clean(
              [
                ...m.warnings,
                "Check the original listing and photos. Details are extracted from listing text and may be wrong.",
              ].join("\n"),
            ).slice(0, 900),
          },
        ],
        footer: {
          text: `Watch: ${w.name.replace(/[@<>]/g, "").slice(0, 80)} · Alert ${id}`,
        },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Open listing", url: l.url },
          ...Object.entries(feedbackActions).map(([action, label]) => ({
            type: 2,
            style: 2,
            label,
            custom_id: `feedback:${action}:${id}`,
          })),
        ],
      },
    ],
  };
}
