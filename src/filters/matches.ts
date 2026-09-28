import {
  attributes,
  type Listing,
  type Normalized,
  type WatchConfig,
} from "../config/schema.js";
export function basicReject(
  l: Listing,
  w: WatchConfig,
  now = Date.now(),
): string | null {
  const haystack =
    `${l.title} ${l.description} ${l.specifics.map((a) => `${a.key} ${a.value}`).join(" ")}`.toLowerCase();
  if (!w.sources.includes(l.source)) return "Source not enabled for watch";
  if (w.excludedKeywords.some((k) => haystack.includes(k.toLowerCase())))
    return "Excluded keyword";
  if (l.source === "ebay" && l.country !== w.country)
    return "Unknown or excluded item location";
  if (
    l.source === "ebay" &&
    w.minSellerPercent !== null &&
    (l.sellerPercent === null || l.sellerPercent < w.minSellerPercent)
  )
    return "Unknown or insufficient seller rating";
  if (
    l.provenance &&
    ["sold", "removed", "pending"].includes(l.provenance.status)
  )
    return "Listing is not active";
  if (w.maxPrice !== null && l.price > w.maxPrice) return "Above maximum price";
  if (w.minPrice !== null && l.price < w.minPrice) return "Below minimum price";
  // Marketplace providers may omit condition; the extracted condition decides then.
  const deferCondition =
    l.source === "facebook_marketplace" && l.condition === "unknown";
  if (!deferCondition && !w.conditions.includes(l.condition))
    return "Excluded or unknown condition";
  if (l.endTime && Date.parse(l.endTime) <= now) return "Listing ended";
  if (
    (w.buying === "fixed" && l.auction) ||
    (w.buying === "auction" && !l.auction)
  )
    return "Wrong buying format";
  return null;
}
export function constraintReject(n: Normalized, w: WatchConfig): string | null {
  if (n.matchStatus === "not_match") return "Not relevant to the search";
  if (!w.conditions.includes(n.condition))
    return "Extracted condition excluded or unknown";
  const values = attributes(n);
  for (const c of w.constraints) {
    const value = values[c.key];
    if (!value || value === "unknown") return `Needs verification: ${c.key}`;
    const target = c.value.toLowerCase().trim();
    if (c.operator === "equals" && value !== target)
      return `Attribute mismatch: ${c.key}`;
    if (c.operator === "contains" && !value.includes(target))
      return `Attribute mismatch: ${c.key}`;
    if (c.operator === "lte" || c.operator === "gte") {
      if (!/^-?\d+(\.\d+)?$/.test(value) || !/^\d+(\.\d+)?$/.test(target))
        return `Invalid numeric evidence: ${c.key}`;
      if (
        c.operator === "lte"
          ? Number(value) > Number(target)
          : Number(value) < Number(target)
      )
        return `Attribute outside range: ${c.key}`;
    }
  }
  return null;
}
