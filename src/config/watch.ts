import { WatchConfig, type ParsedWatch } from "./schema.js";

export const defaultExclusions = [
  "for parts",
  "repair only",
  "broken",
  "empty box",
  "manual only",
  "replica",
];
export const minInterval = 60;
export function prepareWatch(
  parsed: ParsedWatch,
  query: string,
  channel: string,
  previous?: WatchConfig,
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
    minPrice: minPrice ?? null,
    maxPrice: maxPrice ?? null,
    minSellerPercent: parsed.minSellerPercent,
    country: "US",
    currency: "USD",
    buying: parsed.buying,
    channelId: previous?.channelId ?? channel,
    intervalMinutes: Math.max(minInterval, previous?.intervalMinutes ?? 60),
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
