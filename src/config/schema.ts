import { z } from "zod";

export const Condition = z.enum([
  "new",
  "open_box",
  "used",
  "refurbished",
  "for_parts",
  "unknown",
]);
const text = z.string().trim().min(1).max(200);
const money = z.number().finite().min(0).max(10000000);
export const SourceId = z.enum(["ebay", "facebook_marketplace"]);
export type SourceId = z.infer<typeof SourceId>;
export const Location = z
  .object({
    label: text.refine(
      (s) =>
        !/\b\d{1,6}\s+(?:[\w.-]+\s+){1,5}(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|way|boulevard|blvd)\b|[-+]?\d{1,3}\.\d+\s*[, ]\s*[-+]?\d{1,3}\.\d+/i.test(
          s,
        ),
      "Use a city or postal area, not a street address or coordinates",
    ),
    postalCode: z
      .string()
      .regex(/^\d{5}$/)
      .nullable(),
    radiusMiles: z.number().min(1).max(100),
    // "City, ST" for Facebook Marketplace search; derived from a ZIP when needed.
    city: text.nullable().optional(),
  })
  .strict();
export const DeliveryModes = z
  .array(z.enum(["pickup", "shipping"]))
  .min(1)
  .max(2);
export const Attribute = z.object({ key: text, value: text }).strict();
export const Constraint = z
  .object({
    key: text,
    operator: z.enum(["equals", "contains", "lte", "gte"]),
    value: text,
  })
  .strict();
export const ParsedWatch = z
  .object({
    recommendations: z
      .array(
        z
          .object({ phrase: text, reason: text, constraint: Constraint })
          .strict(),
      )
      .max(5)
      .optional(),
    sources: z.array(SourceId).min(1).max(2).nullable(),
    location: Location.nullable(),
    deliveryModes: DeliveryModes.nullable(),
    estimatedTravelCost: money.nullable(),
    name: z.string().min(1).max(80),
    searchTerms: z.string().min(1).max(150),
    excludedKeywords: z.array(text).max(30),
    constraints: z.array(Constraint).max(20),
    conditions: z.array(Condition).min(1).max(6),
    minPrice: money.nullable(),
    maxPrice: money.nullable(),
    minSellerPercent: z.number().min(0).max(100).nullable(),
    country: z.literal("US").nullable(),
    buying: z.enum(["fixed", "auction", "both"]),
    clarifications: z.array(text).max(10),
    assumptions: z.array(text).max(10),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (w) =>
      w.minPrice === null || w.maxPrice === null || w.minPrice <= w.maxPrice,
    "Minimum price exceeds maximum",
  );
export type ParsedWatch = z.infer<typeof ParsedWatch>;
export const WatchConfig = z
  .object({
    name: z.string().min(1).max(80),
    rawQuery: z.string().max(2000),
    searchTerms: z.string().min(1).max(150),
    excludedKeywords: z.array(text),
    constraints: z.array(Constraint),
    conditions: z.array(Condition).min(1),
    // One watch searches every listed source; a user can opt out of either one.
    sources: z.array(SourceId).min(1).max(2),
    // Facebook Marketplace only.
    location: Location.nullable(),
    deliveryModes: DeliveryModes.nullable(),
    estimatedTravelCost: money,
    minPrice: money.nullable(),
    maxPrice: money.nullable(),
    // eBay only; a quality filter, applied only when the watch sets it.
    minSellerPercent: z.number().min(0).max(100).nullable(),
    country: z.literal("US"),
    currency: z.literal("USD"),
    buying: z.enum(["fixed", "auction", "both"]),
    channelId: z.string().min(1),
    intervalMinutes: z.number().int().min(60).max(10080),
  })
  .strict()
  .refine(
    (w) =>
      w.minPrice === null || w.maxPrice === null || w.minPrice <= w.maxPrice,
    "Minimum price exceeds maximum",
  )
  .refine(
    (w) => new Set(w.sources).size === w.sources.length,
    "Duplicate sources",
  );
export type WatchConfig = z.infer<typeof WatchConfig>;
export const Normalized = z
  .object({
    canonicalItem: text,
    attributes: z.array(Attribute).max(40),
    condition: Condition,
    // Whether the listing plausibly matches the watch's search intent at all.
    matchStatus: z.enum(["likely_match", "uncertain", "not_match"]),
    confidence: z.number().min(0).max(1),
    warnings: z.array(text).max(15),
    explanation: z.string().max(500),
  })
  .strict()
  .refine(
    (n) => new Set(n.attributes.map((a) => a.key)).size === n.attributes.length,
    "Duplicate attribute keys",
  );
export type Normalized = z.infer<typeof Normalized>;
export const Listing = z
  .object({
    id: text,
    source: SourceId,
    url: z.url().refine((u) => {
      const x = new URL(u);
      return (
        x.protocol === "https:" &&
        !x.username &&
        !x.password &&
        (x.hostname === "ebay.com" ||
          x.hostname.endsWith(".ebay.com") ||
          (["www.facebook.com", "facebook.com", "m.facebook.com"].includes(
            x.hostname,
          ) &&
            /^\/marketplace\/item\/\d+\/?$/.test(x.pathname)))
      );
    }, "Expected HTTPS eBay or Facebook Marketplace URL"),
    title: z.string().min(1).max(500),
    description: z.string().max(20000),
    specifics: z.array(Attribute),
    price: money,
    shipping: money.nullable(),
    currency: z.literal("USD"),
    condition: Condition,
    sellerName: z.string().max(200),
    sellerPercent: z.number().min(0).max(100).nullable(),
    sellerFeedback: z.number().min(0).nullable(),
    country: z.string().nullable(),
    auction: z.boolean(),
    endTime: z.iso.datetime().nullable(),
    listedAt: z.iso.datetime().nullable().optional(),
    raw: z.unknown(),
    provenance: z
      .object({
        provider: z.string().min(1),
        accessMode: z.enum(["authorized_api", "licensed_provider"]),
        externalId: text,
        retrievedAt: z.iso.datetime(),
        schemaVersion: z.literal("1"),
        evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
        locationLabel: text.nullable(),
        deliveryModes: z.array(z.enum(["pickup", "shipping"])).min(1),
        travelCost: money,
        status: z.enum(["active", "pending", "sold", "removed", "unknown"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (l) =>
      l.source === "ebay"
        ? new URL(l.url).hostname === "ebay.com" ||
          new URL(l.url).hostname.endsWith(".ebay.com")
        : !!l.provenance &&
          l.id.startsWith("facebook_marketplace:") &&
          new URL(l.url).hostname.endsWith("facebook.com"),
    "Source identity mismatch",
  );
export type Listing = z.infer<typeof Listing>;
export const attributes = (item: {
  attributes: { key: string; value: string }[];
}) =>
  Object.fromEntries(
    item.attributes.map((a) => [a.key, a.value.toLowerCase().trim()]),
  );
