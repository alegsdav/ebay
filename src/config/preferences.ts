import { z } from "zod";
import {
  Location,
  WatchConfig,
  type ParsedWatch,
  type SourceId,
} from "./schema.js";

export const UserDefaults = z
  .object({
    location: Location,
    delivery: z.enum(["pickup", "shipping", "either"]),
  })
  .strict();
export type UserDefaults = z.infer<typeof UserDefaults>;

export function updateDefaults(
  previous: UserDefaults | null,
  opts: Record<string, any>,
): UserDefaults {
  if (opts.city && opts.zipcode)
    throw new Error("Choose city OR zipcode, not both.");
  const label = opts.city ?? opts.zipcode ?? previous?.location.label;
  const postalCode =
    opts.zipcode ??
    (opts.city ? null : (previous?.location.postalCode ?? null));
  if (
    !label ||
    !(opts.radius ?? previous?.location.radiusMiles) ||
    !(opts.delivery ?? previous?.delivery)
  )
    throw new Error(
      "First set /defaults with city OR zipcode, radius (miles), and delivery (pickup/shipping/either).",
    );
  return UserDefaults.parse({
    location: {
      label,
      postalCode,
      radiusMiles: opts.radius ?? previous?.location.radiusMiles,
    },
    delivery: opts.delivery ?? previous?.delivery,
  });
}
export function describeDefaults(value: UserDefaults | null) {
  return value
    ? `Your defaults: ${value.location.label} · ${value.location.radiusMiles} miles · ${value.delivery}.\nApplied to future watch previews; explicit query settings override these. Existing watches do not change.`
    : "No defaults saved. Run /defaults with city OR zipcode, radius (miles), and delivery.";
}

export const allSources: SourceId[] = ["ebay", "facebook_marketplace"];
// Discord `sources` option on /watch create and /watch update.
export const sourceChoices = {
  both: allSources,
  ebay_only: ["ebay"],
  facebook_only: ["facebook_marketplace"],
} as const satisfies Record<string, readonly SourceId[]>;
export type SourceChoice = keyof typeof sourceChoices;
export const defaultExclusions = [
  "for parts",
  "repair only",
  "broken",
  "empty box",
  "manual only",
  "replica",
];
export const sourceLabel = (s: SourceId) =>
  s === "ebay" ? "eBay" : "Facebook Marketplace";
// Watches that include Marketplace run at most daily (Bright Data free-tier budget).
export const marketplaceMinInterval = 1440;
export function prepareWatch(
  parsed: ParsedWatch,
  query: string,
  channel: string,
  defaults: UserDefaults | null,
  previous?: WatchConfig,
  sourceChoice?: SourceChoice,
) {
  if (parsed.clarifications.length)
    throw new Error(
      `Please clarify your request: ${parsed.clarifications.join("; ")}`,
    );
  if (parsed.confidence < 0.65)
    throw new Error(
      "Watch interpretation is uncertain. Please make the request more specific.",
    );
  const proposals = parsed.recommendations ?? [];
  const keys = new Set(parsed.constraints.map((c) => c.key));
  for (const proposal of proposals) {
    if (
      !["lte", "gte"].includes(proposal.constraint.operator) ||
      !Number.isFinite(Number(proposal.constraint.value)) ||
      Number(proposal.constraint.value) < 0 ||
      !proposal.constraint.value.trim()
    )
      throw new Error(
        "Gemini must recommend a valid numeric threshold. Please specify the value explicitly.",
      );
    if (keys.has(proposal.constraint.key))
      throw new Error(
        "Interpretation contains conflicting criteria. Please specify the threshold explicitly.",
      );
    keys.add(proposal.constraint.key);
  }
  // Explicit command option > query wording > previous watch > both sources.
  const sources = [
    ...(sourceChoice
      ? sourceChoices[sourceChoice]
      : (parsed.sources ?? previous?.sources ?? allSources)),
  ];
  const marketplace = sources.includes("facebook_marketplace");
  const location =
    parsed.location ?? previous?.location ?? defaults?.location ?? null;
  const deliveryModes =
    parsed.deliveryModes ??
    previous?.deliveryModes ??
    (defaults
      ? defaults.delivery === "either"
        ? (["pickup", "shipping"] as const)
        : [defaults.delivery]
      : null);
  if (marketplace && (!location || !deliveryModes))
    throw new Error(
      "Facebook Marketplace needs a search area. Run /defaults (city OR zipcode, radius, delivery), or choose sources: eBay only.",
    );
  // A revised query replaces keywords and filters; unstated price limits carry over.
  const minPrice =
    parsed.minPrice ?? (parsed.maxPrice === null ? previous?.minPrice : null);
  const maxPrice =
    parsed.maxPrice ?? (parsed.minPrice === null ? previous?.maxPrice : null);
  const searched = parsed.searchTerms.toLowerCase();
  const config = WatchConfig.parse({
    name: parsed.name,
    rawQuery: query,
    searchTerms: parsed.searchTerms,
    // Keep a default exclusion out when the search itself asks for it.
    excludedKeywords: [
      ...new Set([
        ...defaultExclusions.filter((k) => !searched.includes(k)),
        ...parsed.excludedKeywords,
      ]),
    ],
    constraints: [...parsed.constraints, ...proposals.map((p) => p.constraint)],
    conditions: parsed.conditions,
    sources,
    location: marketplace ? location : null,
    deliveryModes: marketplace && deliveryModes ? [...deliveryModes] : null,
    estimatedTravelCost:
      parsed.estimatedTravelCost ?? previous?.estimatedTravelCost ?? 0,
    minPrice: minPrice ?? null,
    maxPrice: maxPrice ?? null,
    minSellerPercent: parsed.minSellerPercent,
    country: "US",
    currency: "USD",
    buying: parsed.buying,
    channelId: previous?.channelId ?? channel,
    intervalMinutes: marketplace
      ? Math.max(
          marketplaceMinInterval,
          previous?.intervalMinutes ?? marketplaceMinInterval,
        )
      : (previous?.intervalMinutes ?? 60),
  });
  const notes = proposals.map(
    (p) =>
      `Confirm recommendation: “${p.phrase.slice(0, 40)}” → ${p.constraint.key} ${p.constraint.operator === "lte" ? "≤" : "≥"} ${p.constraint.value.slice(0, 12)}${p.constraint.key.endsWith("_grams") ? " g" : ""}. ${p.reason.slice(0, 60)}`,
  );
  // Prefill the existing edit modal with concrete proposed values, so users can change them.
  const editableQuery = proposals.length
    ? `${query}\nSpecific criteria (override vague wording): ${proposals.map((p) => `${p.constraint.key} ${p.constraint.operator} ${p.constraint.value}`).join("; ")}`
    : query;
  if (editableQuery.length > 2000)
    throw new Error(
      "Shorten the query to leave room for editable recommendations.",
    );
  return { config, notes, editableQuery };
}
