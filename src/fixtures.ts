// Deliberately synthetic. Never imported into the runtime database automatically.
import {
  type Listing,
  type Normalized,
  type ParsedWatch,
  type WatchConfig,
} from "./config/schema.js";
import { evaluateMatch } from "./filters/evaluate.js";
import type { CloudAlert } from "./cloud/discord.js";
export const parsed: ParsedWatch = {
  name: "Wireless gaming mice",
  searchTerms: "wireless gaming mouse",
  excludedKeywords: [],
  constraints: [{ key: "connectivity", operator: "equals", value: "wireless" }],
  conditions: ["new", "open_box", "used"],
  minPrice: null,
  maxPrice: 85,
  minSellerPercent: null,
  country: "US",
  buying: "fixed",
  clarifications: [],
  assumptions: [],
  confidence: 0.96,
};
export const watch: WatchConfig = {
  name: parsed.name,
  rawQuery: "wireless gaming mice under $85",
  searchTerms: parsed.searchTerms,
  excludedKeywords: ["for parts", "broken"],
  constraints: parsed.constraints,
  conditions: parsed.conditions,
  minPrice: null,
  maxPrice: 85,
  minSellerPercent: null,
  country: "US",
  currency: "USD",
  buying: "fixed",
  channelId: "demo-channel",
  intervalMinutes: 60,
};
export const normalized: Normalized = {
  canonicalItem: "SYNTHETIC Acme Feather 2",
  attributes: [
    { key: "brand", value: "acme" },
    { key: "model", value: "feather 2" },
    { key: "connectivity", value: "wireless" },
    { key: "receiver_included", value: "yes" },
    { key: "weight_grams", value: "60" },
  ],
  condition: "open_box",
  matchStatus: "likely_match",
  confidence: 0.95,
  warnings: [],
  explanation: "Synthetic fixture states exact model and wireless receiver.",
};
export const listing: Listing = {
  id: "synthetic-mouse",
  source: "ebay",
  url: "https://www.ebay.com/itm/000000000000",
  title: "SYNTHETIC Acme Feather 2 Wireless Gaming Mouse",
  description:
    "Fixture only. Receiver included, standalone open box, 60 grams.",
  specifics: normalized.attributes,
  price: 50,
  shipping: 5,
  currency: "USD",
  condition: "open_box",
  sellerName: "synthetic-seller",
  sellerPercent: 99.5,
  sellerFeedback: 1200,
  country: "US",
  auction: false,
  endTime: null,
  raw: { synthetic: true },
};
export function samplePayload(): CloudAlert {
  const match = evaluateMatch(listing, normalized, watch);
  if (!match.matched) throw new Error("Synthetic fixture no longer matches");
  return {
    listing: structuredClone(listing),
    normalized: structuredClone(normalized),
    match,
    config: structuredClone(watch),
  };
}
