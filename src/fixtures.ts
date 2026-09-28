// Deliberately synthetic. Never imported into the runtime database automatically.
import {
  type Comparable,
  type Listing,
  type Normalized,
  type ParsedWatch,
} from "./config/schema.js";
import { resolveWatch } from "./config/categories.js";
import { evaluate } from "./pricing/score.js";
export const fees = {
  taxRate: 0.08,
  buyerRate: 0,
  buyerFixed: 0,
  sellingRate: 0.15,
  sellingFixed: 0.3,
  outboundShipping: 7,
  riskRate: 0.05,
};
export const parsed: ParsedWatch = {
  sources: null,
  location: null,
  deliveryModes: null,
  maxAskingPrice: null,
  estimatedTravelCost: null,
  name: "Wireless gaming mice",
  category: "gaming_mice",
  searchTerms: "wireless gaming mouse",
  excludedKeywords: [],
  constraints: [{ key: "connectivity", operator: "equals", value: "wireless" }],
  conditions: ["new", "open_box", "used"],
  minAllIn: null,
  maxAllIn: 85,
  minDiscountPercent: 20,
  minProfit: 0,
  minSellerPercent: null,
  country: "US",
  buying: "fixed",
  clarifications: [],
  assumptions: [],
  confidence: 0.96,
};
export const watch = resolveWatch(
  parsed,
  "wireless gaming mice under $85",
  "demo-channel",
  fees,
);
export const normalized: Normalized = {
  canonicalItem: "SYNTHETIC Acme Feather 2",
  category: "gaming_mice",
  attributes: [
    { key: "brand", value: "acme" },
    { key: "model", value: "feather 2" },
    { key: "revision", value: "2" },
    { key: "connectivity", value: "wireless" },
    { key: "receiver_included", value: "yes" },
    { key: "bundle", value: "none" },
    { key: "weight_grams", value: "60" },
  ],
  condition: "open_box",
  matchStatus: "likely_match",
  confidence: 0.95,
  warnings: [],
  explanation: "Synthetic fixture states exact model and receiver inclusion.",
  comparableSearchTerms: ["Acme Feather 2"],
};
export const listing: Listing = {
  id: "synthetic-mouse",
  source: "ebay",
  url: "https://www.ebay.com/itm/000000000000",
  title: "SYNTHETIC Acme Feather 2 Wireless Gaming Mouse",
  description:
    "Fixture only. Revision 2, receiver included, standalone open box, 60 grams.",
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
export function comparableFixtures(now = Date.now()): Comparable[] {
  return [98, 100, 102, 105, 110].map((price, i) => ({
    id: `synthetic-${i}`,
    source: "synthetic_fixture",
    sourceUrl: `https://example.com/synthetic-sale/${i}`,
    saleDate: new Date(now - (i + 1) * 86400000).toISOString(),
    retrievedAt: new Date(now).toISOString(),
    salePrice: price,
    shipping: 0,
    currency: "USD",
    category: "gaming_mice",
    condition: "open_box",
    attributes: normalized.attributes,
    evidence: "verified_completed_sale",
  }));
}
export function samplePayload() {
  return {
    listing,
    normalized,
    config: watch,
    evaluation: evaluate(listing, normalized, watch, comparableFixtures()),
  };
}
