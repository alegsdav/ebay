import type { Listing, Normalized, WatchConfig } from "../config/schema.js";
import { basicReject, constraintReject } from "./matches.js";
export interface MatchResult {
  matched: boolean;
  reason: string | null;
  warnings: string[];
}
export const minExtractionConfidence = 0.65;
export function evaluateMatch(
  l: Listing,
  n: Normalized,
  w: WatchConfig,
  now = Date.now(),
): MatchResult {
  const warnings = [...n.warnings];
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
