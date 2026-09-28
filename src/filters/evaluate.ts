import type { Listing, Normalized, WatchConfig } from "../config/schema.js";
import { basicReject, constraintReject } from "./matches.js";
export interface MatchResult {
  matched: boolean;
  reason: string | null;
  warnings: string[];
}
export const minExtractionConfidence = 0.65;
// Phrases that call for extra care on Marketplace; they warn, never accuse or block.
const marketplaceRisks = [
  "deposit",
  "wire transfer",
  "gift card",
  "crypto",
  "stock photo",
  "shipping only",
];
export function evaluateMatch(
  l: Listing,
  n: Normalized,
  w: WatchConfig,
  now = Date.now(),
): MatchResult {
  const warnings = [...n.warnings];
  if (l.source === "facebook_marketplace") {
    const text = `${l.title} ${l.description}`.toLowerCase();
    warnings.push(
      ...marketplaceRisks
        .filter((r) => text.includes(r))
        .map((r) => `Requires verification: ${r}`),
      "Verify the item, condition and seller in person before paying.",
    );
  }
  if (l.auction)
    warnings.push("Current bid is provisional; final price may rise.");
  const reason =
    basicReject(l, w, now) ??
    constraintReject(n, w) ??
    (n.confidence < minExtractionConfidence
      ? "Insufficient extraction confidence"
      : null);
  return { matched: reason === null, reason, warnings };
}
