import {
  attributes,
  type Comparable,
  type Listing,
  type Normalized,
  type WatchConfig,
} from "../config/schema.js";
import { templates } from "../config/categories.js";
import { basicReject, constraintReject } from "../filters/matches.js";
export const cents = (n: number) => Math.round((n + Number.EPSILON) * 100);
export const dollars = (n: number) => n / 100;
export function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new Error("No prices");
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[m]!
    : Math.round((sorted[m - 1]! + sorted[m]!) / 2);
}
const known = (v: string | undefined): v is string =>
  !!v && !["unknown", "unspecified", "n/a"].includes(v);
export function matchComparables(
  n: Normalized,
  rows: Comparable[],
  w: WatchConfig,
  now = Date.now(),
) {
  const identity = templates[w.category].identity;
  const a = attributes(n);
  const seen = new Set<string>();
  if (identity.some((k) => !known(a[k]))) return [];
  return rows.filter((c) => {
    const sale = Date.parse(c.saleDate);
    const b = attributes(c);
    const url = new URL(c.sourceUrl);
    const key = url.origin + url.pathname;
    if (
      c.evidence !== "verified_completed_sale" ||
      c.source === "facebook_marketplace" ||
      url.hostname === "facebook.com" ||
      url.hostname.endsWith(".facebook.com") ||
      c.category !== w.category ||
      c.currency !== w.currency ||
      c.condition !== n.condition ||
      sale > now ||
      sale < now - w.lookbackDays * 86400000 ||
      seen.has(key)
    )
      return false;
    if (!identity.every((k) => known(b[k]) && b[k] === a[k])) return false;
    seen.add(key);
    return true;
  });
}
export interface Metrics {
  travelCost?: number;
  allIn: number;
  purchase: number;
  inboundShipping: number;
  buyerFees: number;
  taxes: number;
  median: number;
  low: number;
  high: number;
  netResale: number;
  sellingFees: number;
  outboundShipping: number;
  riskReserve: number;
  profit: number;
  discountPercent: number;
  maxBid: number;
  count: number;
  oldest: string;
  newest: string;
  score: number;
}
export interface Evaluation {
  tier: "strong" | "possible" | "silent";
  reasons: string[];
  warnings: string[];
  metrics: Metrics | null;
  comparables: Comparable[];
}
export function evaluate(
  l: Listing,
  n: Normalized,
  w: WatchConfig,
  rows: Comparable[],
  now = Date.now(),
): Evaluation {
  const warnings = [...n.warnings];
  const marketplace = l.source === "facebook_marketplace";
  const marketRisks = marketplace
    ? [
        "deposit",
        "wire transfer",
        "gift card",
        "crypto",
        "stock photo",
        "shipping only",
      ].filter((r) => `${l.title} ${l.description}`.toLowerCase().includes(r))
    : [];
  if (marketplace)
    warnings.push(
      "User-submitted Marketplace asking price; not completed-sale evidence.",
      "Verify model, condition, accessories and seller in person. Seller evidence is unknown; confidence capped at Tier 2.",
      ...marketRisks.map((r) => `Requires verification: ${r}`),
    );
  const silent = (
    reason: string,
    comps: Comparable[] = [],
    metrics: Metrics | null = null,
  ): Evaluation => ({
    tier: "silent",
    reasons: [reason],
    warnings,
    metrics,
    comparables: comps,
  });
  const reject = basicReject(l, w, now) ?? constraintReject(n, w);
  if (reject) return silent(reject);
  if (marketplace && (l.condition === "unknown" || n.condition === "unknown"))
    return silent("Unknown condition; Tier 3 only");
  if (n.condition !== l.condition)
    return silent("Source and extracted condition conflict");
  if (l.shipping === null)
    return silent("Shipping unknown; all-in cost unavailable");
  if (l.auction && !l.endTime) return silent("Auction end time unknown");
  const comps = matchComparables(n, rows, w, now);
  if (comps.length < w.minComparables)
    return silent(
      `Only ${comps.length}/${w.minComparables} exact verified sales`,
      comps,
    );
  const prices = comps.map((c) => cents(c.salePrice) + cents(c.shipping));
  const med = median(prices),
    low = Math.min(...prices),
    high = Math.max(...prices);
  const f = w.fees;
  const purchase = cents(l.price),
    shipping = cents(l.shipping);
  const travel = marketplace ? cents(l.provenance?.travelCost ?? 0) : 0;
  const buyerFees = Math.round(purchase * f.buyerRate) + cents(f.buyerFixed);
  // Conservative estimate: tax purchase, shipping and buyer fees. Location-specific tax rules vary.
  const taxes = Math.round((purchase + shipping + buyerFees) * f.taxRate);
  const sellingFees = Math.round(med * f.sellingRate) + cents(f.sellingFixed),
    risk = Math.round(med * f.riskRate),
    outbound = cents(f.outboundShipping);
  const allIn =
    purchase + shipping + buyerFees + taxes + travel + (marketplace ? risk : 0);
  const net = med - sellingFees - outbound - (marketplace ? 0 : risk),
    profit = net - allIn,
    discount = (100 * (med - allIn)) / med;
  const cap = Math.min(
    net - cents(w.minProfit),
    Math.floor(med * (1 - w.minDiscountPercent / 100)),
    w.maxAllIn === null ? Infinity : cents(w.maxAllIn),
  );
  // Binary search cent amounts so rounding cannot make the reported bid exceed the all-in cap.
  const cost = (p: number) => {
    const base =
      p + shipping + Math.round(p * f.buyerRate) + cents(f.buyerFixed);
    return (
      base + Math.round(base * f.taxRate) + travel + (marketplace ? risk : 0)
    );
  };
  let lo = 0,
    hi = Math.max(0, Math.floor(cap));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(mid) <= cap) lo = mid;
    else hi = mid - 1;
  }
  const quality =
    Math.min(1, comps.length / 10) * Math.max(0, 1 - (high - low) / med);
  const completeness = templates[w.category].identity.every((k) =>
    known(attributes(n)[k]),
  )
    ? 1
    : 0;
  const score = Math.round(
    40 * Math.max(0, Math.min(1, discount / 50)) +
      25 * quality +
      15 * n.confidence +
      (10 * (l.sellerPercent ?? 0)) / 100 +
      10 * completeness,
  );
  const dates = comps.map((c) => c.saleDate).sort();
  const metrics: Metrics = {
    ...(marketplace ? { travelCost: dollars(travel) } : {}),
    allIn: dollars(allIn),
    purchase: dollars(purchase),
    inboundShipping: dollars(shipping),
    buyerFees: dollars(buyerFees),
    taxes: dollars(taxes),
    median: dollars(med),
    low: dollars(low),
    high: dollars(high),
    netResale: dollars(net),
    sellingFees: dollars(sellingFees),
    outboundShipping: dollars(outbound),
    riskReserve: dollars(risk),
    profit: dollars(profit),
    discountPercent: Math.round(discount * 10) / 10,
    maxBid: dollars(lo),
    count: comps.length,
    oldest: dates[0]!,
    newest: dates.at(-1)!,
    score,
  };
  if (
    (w.maxAllIn !== null && allIn > cents(w.maxAllIn)) ||
    (w.minAllIn !== null && allIn < cents(w.minAllIn))
  )
    return silent("All-in cost outside budget", comps, metrics);
  if (discount < w.minDiscountPercent || profit < cents(w.minProfit))
    return silent("Below discount or profit threshold", comps, metrics);
  if (n.confidence < 0.65)
    return silent("Insufficient extraction confidence", comps, metrics);
  const text = `${l.title} ${l.description}`.toLowerCase();
  const risks = templates[w.category].risks.filter((k) => text.includes(k));
  warnings.push(...risks.map((r) => `Risk signal: ${r}`));
  if (l.auction)
    warnings.push("Current bid is provisional; final price may rise.");
  if ((high - low) / med > 0.5)
    warnings.push("Wide comparable price spread; review sale evidence.");
  const strong =
    !marketplace &&
    n.matchStatus === "likely_match" &&
    n.confidence >= w.minConfidence &&
    n.warnings.length === 0 &&
    risks.length === 0 &&
    (high - low) / med <= 0.5;
  return {
    tier: strong ? "strong" : "possible",
    reasons: [
      `${comps.length} exact, condition-matched verified sales`,
      `${metrics.discountPercent}% below the delivered-sale median`,
      n.explanation,
    ],
    warnings,
    metrics,
    comparables: comps,
  };
}
