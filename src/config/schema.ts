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
    minPrice: money.nullable(),
    maxPrice: money.nullable(),
    // A quality filter, applied only when the watch sets it.
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
    source: z.literal("ebay"),
    url: z.url().refine((u) => {
      const x = new URL(u);
      return (
        x.protocol === "https:" &&
        !x.username &&
        !x.password &&
        (x.hostname === "ebay.com" || x.hostname.endsWith(".ebay.com"))
      );
    }, "Expected HTTPS eBay URL"),
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
  })
  .strict();
export type Listing = z.infer<typeof Listing>;
export const attributes = (item: {
  attributes: { key: string; value: string }[];
}) =>
  Object.fromEntries(
    item.attributes.map((a) => [a.key, a.value.toLowerCase().trim()]),
  );
