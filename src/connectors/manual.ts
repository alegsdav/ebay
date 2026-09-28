import { z } from "zod";
import {
  Condition,
  Listing,
  Location,
  Normalized,
  WatchConfig,
  type Comparable,
} from "../config/schema.js";
import { assertSourceAccess } from "./source.js";
import type { Interpreter } from "../llm/client.js";
import { PROMPT_VERSION } from "../llm/client.js";
import { evaluate } from "../pricing/score.js";
import { alertMessage, type Message } from "../cloud/discord.js";

export function redact(text: string) {
  return text
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email removed]")
    .replace(
      /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
      "[phone removed]",
    )
    .replace(
      /\b\d{1,6}\s+(?:[\w.-]+\s+){1,5}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|way|boulevard|blvd)\b[^\n,]*/gi,
      "[address removed]",
    );
}
export const ManualInput = z
  .object({
    source: z.literal("facebook"),
    url: z.url(),
    title: z.string().trim().min(1).max(500),
    price: z.number().finite().min(0).max(10000000),
    location: Location.shape.label,
    notes: z.string().max(12000).default(""),
    condition: Condition.default("unknown"),
    travel: z.number().finite().min(0).max(100000).default(0),
  })
  .strict();
export const ManualDraft = z
  .object({ listing: Listing, config: WatchConfig })
  .strict();
export type ManualDraft = z.infer<typeof ManualDraft>;
export function marketplaceIdentity(value: string) {
  const url = new URL(value);
  const match = /^\/marketplace\/item\/(\d+)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(
      url.hostname,
    ) ||
    !match
  )
    throw new Error(
      "Use an HTTPS Facebook Marketplace item URL. The server will not fetch it.",
    );
  const externalId = match[1]!;
  return {
    externalId,
    url: `https://www.facebook.com/marketplace/item/${externalId}/`,
  };
}
export async function manualDraft(
  input: unknown,
  config: WatchConfig,
): Promise<ManualDraft> {
  assertSourceAccess("facebook_marketplace", "manual", "user_submitted", true);
  const data = ManualInput.parse(input);
  const { externalId, url } = marketplaceIdentity(data.url);
  const facts = {
    title: redact(data.title),
    description: redact(data.notes),
    price: data.price,
    condition: data.condition,
    location: redact(data.location),
    travel: data.travel,
  };
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(facts)),
  );
  const listing = Listing.parse({
    id: `facebook_marketplace:manual:${externalId}`,
    source: "facebook_marketplace",
    url,
    title: facts.title,
    description: facts.description,
    specifics: [],
    price: facts.price,
    shipping: 0,
    currency: "USD",
    condition: facts.condition,
    sellerName: "unknown",
    sellerPercent: null,
    sellerFeedback: null,
    country: null,
    auction: false,
    endTime: null,
    raw: { submittedFacts: facts },
    provenance: {
      provider: "manual",
      accessMode: "user_submitted",
      externalId,
      retrievedAt: new Date().toISOString(),
      schemaVersion: "1",
      evidenceHash: Array.from(new Uint8Array(hash), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join(""),
      locationLabel: facts.location,
      deliveryModes: ["pickup"],
      travelCost: facts.travel,
      status: "unknown",
    },
  });
  return ManualDraft.parse({ listing, config });
}
export function manualPreview(draft: ManualDraft, id: string): Message {
  const l = draft.listing;
  const safe = (s: string) => s.replace(/[@*_`<>]/g, "");
  return {
    content: `User-submitted Marketplace listing · manual\n${safe(l.title)}\nAsking $${l.price.toFixed(2)} · pickup travel $${l.provenance!.travelCost.toFixed(2)} · ${safe(l.provenance!.locationLabel ?? "unknown")} · condition ${l.condition}\n${draft.config.minComparables} exact independent sold comparables required · Tier 2 maximum.\nReview the attached facts and fee assumptions. No negotiated discount. Confirm before normalization and scoring. No Facebook request is made. Expires in 15 minutes.`,
    files: [
      { name: "listing-preview.json", content: JSON.stringify(draft, null, 2) },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Confirm evaluation",
            custom_id: `manual:confirm:${id}`,
          },
          {
            type: 2,
            style: 4,
            label: "Cancel",
            custom_id: `manual:cancel:${id}`,
          },
        ],
      },
    ],
  };
}
export async function evaluateManual(
  draft: ManualDraft,
  llm: Interpreter,
  rows: Comparable[],
): Promise<Message> {
  const { listing, config } = ManualDraft.parse(draft);
  const normalized = Normalized.parse(await llm.normalize(listing, config));
  const evaluation = evaluate(listing, normalized, config, rows);
  const payload = {
    listing,
    normalized,
    evaluation,
    config,
    extraction: { model: llm.model, promptVersion: PROMPT_VERSION },
  };
  const message: Message = evaluation.metrics
    ? alertMessage(payload, "manual-evaluation")
    : {
        embeds: [
          {
            title: "INSUFFICIENT EVIDENCE / NO QUALIFYING DEAL",
            description: evaluation.reasons.join("\n").slice(0, 1000),
            fields: [
              {
                name: "Independent sold comparables",
                value: String(evaluation.comparables.length),
              },
              {
                name: "Asking price / estimated travel",
                value: `$${listing.price.toFixed(2)} / $${listing.provenance!.travelCost.toFixed(2)}`,
              },
              {
                name: "Warnings",
                value: evaluation.warnings.join("\n").slice(0, 1000),
              },
            ],
          },
        ],
      };
  if (evaluation.metrics && evaluation.tier === "silent")
    message.embeds![0].title = message.embeds![0].title.replace(
      "POSSIBLE MATCH",
      "DOES NOT QUALIFY",
    );
  return {
    ...message,
    content: `User-submitted Marketplace listing · manual · ${listing.provenance!.locationLabel?.replace(/[@*_`<>]/g, "")} · pickup\n${evaluation.tier === "silent" ? "Tier 3 / does not qualify" : "Tier 2 maximum"}. Asking prices are not sold evidence. Verify in person.`,
    components: [],
    files: [
      {
        name: "listing-evaluation.json",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
