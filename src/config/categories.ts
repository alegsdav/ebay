import {
  type CategoryId as CategorySchema,
  type ParsedWatch,
  type WatchConfig,
  type Fees,
  WatchConfig as Config,
} from "./schema.js";
import type { z } from "zod";
type Category = z.infer<typeof CategorySchema>;
export interface Template {
  name: string;
  categoryId: string;
  identity: string[];
  attributes: string[];
  risks: string[];
}
// These IDs are operator-controlled and validated with eBay Taxonomy before each process uses them.
// The LLM never supplies marketplace category IDs or filter syntax.
export const templates: Record<Category, Template> = {
  gaming_mice: {
    name: "Gaming mice",
    categoryId: "23160",
    identity: [
      "brand",
      "model",
      "revision",
      "connectivity",
      "receiver_included",
      "bundle",
    ],
    attributes: ["weight_grams", "color"],
    risks: ["missing receiver", "missing dongle", "double click", "defective"],
  },
  pokemon_cards: {
    name: "Graded Pokémon cards",
    categoryId: "183454",
    identity: [
      "set",
      "card_number",
      "grade",
      "grader",
      "language",
      "edition",
      "variant",
    ],
    attributes: ["year"],
    risks: ["proxy", "custom", "reprint", "cracked slab", "replica"],
  },
  gpus: {
    name: "Graphics cards",
    categoryId: "27386",
    identity: ["brand", "model", "vram_gb", "revision", "functional", "bundle"],
    attributes: ["warranty"],
    risks: ["mining", "artifacting", "untested", "no display"],
  },
  camera_lenses: {
    name: "Camera lenses",
    categoryId: "3323",
    identity: [
      "brand",
      "model",
      "mount",
      "focal_length",
      "aperture",
      "autofocus",
      "accessories",
    ],
    attributes: [],
    risks: ["fungus", "haze", "scratches", "stuck aperture"],
  },
  sneakers: {
    name: "Sneakers",
    categoryId: "15709",
    identity: [
      "brand",
      "model",
      "style_code",
      "size",
      "size_system",
      "colorway",
      "box_included",
    ],
    attributes: ["authentication"],
    risks: ["replica", "sole separation", "custom", "unauthenticated"],
  },
  power_tools: {
    name: "Power tools",
    categoryId: "3247",
    identity: [
      "brand",
      "model",
      "voltage",
      "battery_included",
      "charger_included",
      "bundle",
    ],
    attributes: [],
    risks: ["tool only", "battery absent", "damaged", "untested"],
  },
};
export const defaultExclusions = [
  "for parts",
  "repair only",
  "broken",
  "empty box",
  "manual only",
  "replica",
];
export function resolveWatch(
  parsed: ParsedWatch,
  rawQuery: string,
  channelId: string,
  fees: Fees,
  allowMarketplaceDraft = false,
): WatchConfig {
  if (parsed.sources?.includes("facebook_marketplace") && !parsed.location)
    throw new Error(
      "Marketplace searches require a city/postal area and radius.",
    );
  if (
    !allowMarketplaceDraft &&
    (parsed.sources?.includes("facebook_marketplace") ||
      /facebook|marketplace|\blocal\b/i.test(rawQuery))
  )
    throw new Error(
      "Marketplace discovery is pending Bright Data. Use /defaults then /watch create to prepare confirmed criteria.",
    );
  if (!parsed.category)
    throw new Error(
      "Unsupported or ambiguous category. Edit the request to select an enabled category.",
    );
  if (parsed.confidence < 0.65)
    throw new Error(
      "Watch interpretation is uncertain. Please make the request more specific.",
    );
  const template = templates[parsed.category];
  for (const c of parsed.constraints)
    if (![...template.identity, ...template.attributes].includes(c.key))
      throw new Error(`Unsupported attribute: ${c.key}. Edit the query.`);
  return Config.parse({
    sources: parsed.sources ?? ["ebay"],
    location: parsed.location,
    deliveryModes: parsed.deliveryModes ?? ["shipping"],
    maxAskingPrice: parsed.maxAskingPrice,
    estimatedTravelCost: parsed.estimatedTravelCost ?? 0,
    name: parsed.name,
    category: parsed.category,
    rawQuery,
    searchTerms: parsed.searchTerms,
    excludedKeywords: [
      ...new Set([...defaultExclusions, ...parsed.excludedKeywords]),
    ],
    constraints: parsed.constraints,
    conditions: parsed.conditions,
    minAllIn: parsed.minAllIn,
    maxAllIn: parsed.maxAllIn,
    minDiscountPercent: parsed.minDiscountPercent ?? 20,
    minProfit: parsed.minProfit ?? 0,
    minSellerPercent: parsed.minSellerPercent ?? 98,
    country: "US",
    currency: "USD",
    minComparables: 5,
    lookbackDays: 90,
    minConfidence: 0.85,
    buying: parsed.buying,
    channelId,
    possibleChannelId: null,
    intervalMinutes: 60,
    fees,
  });
}
