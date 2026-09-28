import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, matchComparables, median } from "../src/pricing/score.js";
import {
  listing,
  normalized,
  watch,
  comparableFixtures,
  parsed,
  fees,
} from "../src/fixtures.js";
import { resolveWatch } from "../src/config/categories.js";
import { Comparable, ParsedWatch } from "../src/config/schema.js";
test("cent-accurate acquisition and resale arithmetic; median includes comparable shipping", () => {
  const result = evaluate(listing, normalized, watch, comparableFixtures());
  assert.equal(result.tier, "strong");
  const m = result.metrics!;
  assert.equal(m.allIn, 59.4);
  assert.equal(m.median, 102);
  assert.equal(m.sellingFees, 15.6);
  assert.equal(m.riskReserve, 5.1);
  assert.equal(m.netResale, 74.3);
  assert.equal(m.profit, 14.9);
  assert.equal(m.discountPercent, 41.8);
  assert.equal(m.maxBid, 63.8);
  assert.equal(
    evaluate(
      { ...listing, price: m.maxBid },
      normalized,
      watch,
      comparableFixtures(),
    ).tier,
    "strong",
  );
  assert.equal(
    evaluate(
      { ...listing, price: m.maxBid + 0.01 },
      normalized,
      watch,
      comparableFixtures(),
    ).tier,
    "silent",
  );
  assert.equal(median([100, 300, 200, 900]), 250);
});
test("refuses unknown shipping, seller/location, mismatched attributes and budgets", () => {
  for (const change of [
    { shipping: null },
    { sellerPercent: null },
    { country: null },
    { price: 100 },
    { condition: "unknown" as const },
  ])
    assert.equal(
      evaluate(
        { ...listing, ...change },
        normalized,
        watch,
        comparableFixtures(),
      ).tier,
      "silent",
    );
  assert.equal(
    evaluate(
      listing,
      {
        ...normalized,
        attributes: normalized.attributes.filter(
          (a) => a.key !== "connectivity",
        ),
      },
      watch,
      comparableFixtures(),
    ).tier,
    "silent",
  );
});
test("completed sales must match identity, condition, dates and unique provenance", () => {
  const rows = comparableFixtures();
  const bad = [
    { ...rows[0]!, condition: "used" as const },
    { ...rows[1]!, saleDate: new Date(Date.now() + 86400000).toISOString() },
    { ...rows[2]!, saleDate: "2020-01-01T00:00:00.000Z" },
    {
      ...rows[3]!,
      attributes: rows[3]!.attributes.map((a) =>
        a.key === "revision" ? { ...a, value: "1" } : a,
      ),
    },
  ];
  assert.equal(matchComparables(normalized, bad, watch).length, 0);
  assert.equal(
    matchComparables(
      normalized,
      [
        rows[0]!,
        {
          ...rows[0]!,
          id: "duplicate",
          sourceUrl: rows[0]!.sourceUrl + "?tracking=1",
        },
      ],
      watch,
    ).length,
    1,
  );
  assert.equal(
    Comparable.safeParse({ ...rows[0], evidence: "asking_price" }).success,
    false,
  );
});
test("unknown identity never matches another unknown identity", () => {
  const unknown = {
    ...normalized,
    attributes: normalized.attributes.map((a) =>
      a.key === "receiver_included" ? { ...a, value: "unknown" } : a,
    ),
  };
  const rows = comparableFixtures().map((c) => ({
    ...c,
    attributes: unknown.attributes,
  }));
  assert.equal(matchComparables(unknown, rows, watch).length, 0);
});
test("low confidence and warnings downgrade or silence deals; auctions are provisional", () => {
  assert.equal(
    evaluate(
      listing,
      { ...normalized, confidence: 0.7 },
      watch,
      comparableFixtures(),
    ).tier,
    "possible",
  );
  assert.equal(
    evaluate(
      listing,
      { ...normalized, confidence: 0.4 },
      watch,
      comparableFixtures(),
    ).tier,
    "silent",
  );
  assert.equal(
    evaluate(
      listing,
      { ...normalized, warnings: ["Inspect receiver"] },
      watch,
      comparableFixtures(),
    ).tier,
    "possible",
  );
  const auction = {
    ...listing,
    auction: true,
    endTime: new Date(Date.now() + 3600000).toISOString(),
  };
  assert.ok(
    evaluate(
      auction,
      normalized,
      { ...watch, buying: "auction" },
      comparableFixtures(),
    ).warnings.some((w) => w.includes("provisional")),
  );
  assert.equal(
    evaluate(
      { ...auction, endTime: null },
      normalized,
      { ...watch, buying: "auction" },
      comparableFixtures(),
    ).tier,
    "silent",
  );
});
test("numeric watch constraints fail closed on missing and unparseable evidence", () => {
  const w = {
    ...watch,
    constraints: [
      { key: "weight_grams", operator: "lte" as const, value: "70" },
    ],
  };
  assert.equal(
    evaluate(listing, normalized, w, comparableFixtures()).tier,
    "strong",
  );
  const heavy = {
    ...normalized,
    attributes: normalized.attributes.map((a) =>
      a.key === "weight_grams" ? { ...a, value: "80" } : a,
    ),
  };
  assert.equal(
    evaluate(listing, heavy, w, comparableFixtures()).tier,
    "silent",
  );
});
test("vague watch does not invent a budget or weight constraint; unsupported categories rejected", () => {
  const w = resolveWatch(
    { ...parsed, constraints: [], maxAllIn: null },
    "lightweight gaming mice",
    "123",
    fees,
  );
  assert.equal(w.maxAllIn, null);
  assert.deepEqual(w.constraints, []);
  assert.equal(w.minDiscountPercent, 20);
  assert.throws(() =>
    resolveWatch({ ...parsed, category: null }, "cars", "123", fees),
  );
  assert.equal(
    ParsedWatch.safeParse({ ...parsed, minAllIn: 100, maxAllIn: 50 }).success,
    false,
  );
  assert.throws(() =>
    resolveWatch(
      {
        ...parsed,
        constraints: [
          { key: "arbitrary_category_id", operator: "equals", value: "123" },
        ],
      },
      "mice",
      "123",
      fees,
    ),
  );
});

test("all six category templates enforce their own identity keys", async () => {
  const { templates } = await import("../src/config/categories.js");
  for (const category of Object.keys(templates) as (keyof typeof templates)[]) {
    const attrs = templates[category].identity.map((key) => ({
      key,
      value: `exact-${key}`,
    }));
    const n = { ...normalized, category, attributes: attrs };
    const w = { ...watch, category, constraints: [] };
    const comps = comparableFixtures().map((c) => ({
      ...c,
      category,
      attributes: attrs,
    }));
    assert.equal(matchComparables(n, comps, w).length, 5, category);
    const mismatch = comps.map((c) => ({
      ...c,
      attributes: c.attributes.map((a, i) =>
        i === 0 ? { ...a, value: "different" } : a,
      ),
    }));
    assert.equal(matchComparables(n, mismatch, w).length, 0, category);
  }
});
