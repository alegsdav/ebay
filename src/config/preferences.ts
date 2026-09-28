import { z } from "zod";
import {
  Location,
  type ParsedWatch,
  type WatchConfig,
  type Fees,
} from "./schema.js";
import { resolveWatch } from "./categories.js";

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

export function prepareWatch(
  parsed: ParsedWatch,
  query: string,
  channel: string,
  fees: Fees,
  defaults: UserDefaults | null,
  previous?: WatchConfig,
) {
  if (parsed.clarifications.length)
    throw new Error(
      `Please clarify your request: ${parsed.clarifications.join("; ")}`,
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
  const sources = parsed.sources ??
    previous?.sources ?? ["facebook_marketplace"];
  const marketplace = sources.includes("facebook_marketplace");
  if (sources.length !== 1)
    throw new Error("Use a separate watch for each marketplace.");
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
      "Set /defaults first: city OR zipcode, radius, and delivery. Then create your watch again.",
    );
  const config = resolveWatch(
    {
      ...parsed,
      sources,
      location,
      deliveryModes: deliveryModes ? [...deliveryModes] : null,
      constraints: [
        ...parsed.constraints,
        ...proposals.map((p) => p.constraint),
      ],
    },
    query,
    channel,
    fees,
    true,
  );
  config.rawQuery = query;
  config.sources = sources;
  if (marketplace) {
    config.purpose = "match";
    config.intervalMinutes = 1440;
    config.maxAskingPrice = parsed.maxAskingPrice ?? parsed.maxAllIn;
  }
  const notes = proposals.map(
    (p) =>
      `Confirm recommendation: “${p.phrase.slice(0, 40)}” → ${p.constraint.key} ${p.constraint.operator === "lte" ? "≤" : "≥"} ${p.constraint.value.slice(0, 12)}${p.constraint.key === "weight_grams" ? " g" : ""}. ${p.reason.slice(0, 60)}`,
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
