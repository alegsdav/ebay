import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} from "discord.js";
import type { Listing, Normalized, WatchConfig } from "../config/schema.js";
import type { Evaluation } from "../pricing/score.js";
export const disclaimer =
  "Estimates are informational only. Verify authenticity, condition, fees, shipping, and comparable sales before bidding.";
const safe = (s: string, n = 1000) =>
  escapeMarkdown(s).replace(/@/g, "＠").slice(0, n);
export const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n,
  );
export interface AlertPayload {
  listing: Listing;
  normalized: Normalized;
  evaluation: Evaluation;
  config: WatchConfig;
}
export function formatAlert(p: AlertPayload, id: string) {
  const { listing: l, normalized: n, evaluation: e } = p;
  const m = e.metrics;
  if (!m) throw new Error("Cannot format an unpriced deal");
  const evidence: string[] = [];
  for (const [i, c] of e.comparables.slice(0, 5).entries()) {
    const line = `[Sale ${i + 1}](<${new URL(c.sourceUrl).href}>) · ${usd(c.salePrice + c.shipping)} · ${c.saleDate.slice(0, 10)}`;
    if ([...evidence, line].join("\n").length > 900) break;
    evidence.push(line);
  }
  const evidenceText =
    evidence.join("\n") || "Full source links: /listing details";
  const embed = new EmbedBuilder()
    .setTitle(
      `${e.tier === "strong" ? "POTENTIAL DEAL" : "POSSIBLE MATCH"} · ${safe(l.title, 210)}`,
    )
    .setURL(l.url)
    .setColor(e.tier === "strong" ? 0x27ae60 : 0xe6a23c)
    .setDescription(safe(e.reasons.join("\n"), 700))
    .addFields(
      {
        name: l.auction ? "Current bid (provisional)" : "Asking price",
        value: usd(m.purchase),
        inline: true,
      },
      { name: "Inbound shipping", value: usd(m.inboundShipping), inline: true },
      { name: "Estimated all-in", value: usd(m.allIn), inline: true },
      {
        name: "Acquisition assumptions",
        value: `Buyer fees ${usd(m.buyerFees)} · tax ${usd(m.taxes)} (${p.config.fees.taxRate * 100}% estimate)${l.source === "facebook_marketplace" ? ` · travel ${usd(m.travelCost ?? 0)} · risk reserve ${usd(m.riskReserve)}` : ""}`,
      },
      {
        name: "Verified delivered-sale comparables",
        value: `Median ${usd(m.median)} · range ${usd(m.low)}–${usd(m.high)}\n${m.count} sales · ${m.oldest.slice(0, 10)} to ${m.newest.slice(0, 10)}`,
      },
      {
        name: "Resale assumptions",
        value: `Selling fees ${usd(m.sellingFees)} · shipping ${usd(m.outboundShipping)}${l.source === "ebay" ? ` · risk ${usd(m.riskReserve)}` : ""}`,
      },
      { name: "Estimated net resale", value: usd(m.netResale), inline: true },
      { name: "Estimated profit", value: usd(m.profit), inline: true },
      {
        name: "Discount / ranking",
        value: `${m.discountPercent}% · ${m.score}/100`,
        inline: true,
      },
      {
        name: l.auction
          ? "Estimated maximum sensible bid"
          : "Estimated maximum purchase price",
        value: usd(m.maxBid),
        inline: true,
      },
      {
        name: "Extraction confidence",
        value: `${Math.round(n.confidence * 100)}% · ${safe(n.condition)}`,
        inline: true,
      },
      {
        name: "Seller",
        value: `${safe(l.sellerName, 100)} · ${l.sellerPercent ?? "unknown"}% positive · ${l.sellerFeedback ?? "unknown"} feedback`,
        inline: true,
      },
      {
        name: "Identity / grade",
        value:
          safe(n.attributes.map((a) => `${a.key}: ${a.value}`).join(" · ")) ||
          "Unknown",
      },
      {
        name: "Ends",
        value: l.endTime
          ? `<t:${Math.floor(Date.parse(l.endTime) / 1000)}:R>`
          : "Not provided",
      },
      {
        name: "Sale evidence (first 5)",
        value: evidenceText,
      },
      {
        name: "Warnings",
        value: safe(
          [
            ...e.warnings,
            "Inspect original listing and photos. Text extraction does not verify authenticity.",
          ].join("\n"),
        ),
      },
    )
    .setFooter({ text: `${disclaimer} • Alert ${id}` })
    .setTimestamp();
  if (l.source === "facebook_marketplace")
    embed.addFields({
      name: "Source / pickup",
      value: `User-submitted Marketplace listing · ${safe(l.provenance?.locationLabel ?? "unknown", 200)} · travel ${usd(m.travelCost ?? 0)}\nAsking price only; verify in person. Tier 2 maximum.`,
    });
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open listing")
      .setStyle(ButtonStyle.Link)
      .setURL(l.url),
    ...(["reviewed", "saved", "dismissed", "incorrect_match"] as const).map(
      (action) =>
        new ButtonBuilder()
          .setCustomId(`feedback:${action}:${id}`)
          .setLabel(
            {
              reviewed: "Reviewed",
              saved: "Save",
              dismissed: "Dismiss",
              incorrect_match: "Not a match",
            }[action],
          )
          .setStyle(ButtonStyle.Secondary),
    ),
  );
  return {
    embeds: [embed],
    components: [actions],
    allowedMentions: { parse: [] as [] },
  };
}
