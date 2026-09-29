import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMatch } from "../src/filters/evaluate.js";
import { listing, normalized, watch } from "../src/fixtures.js";
import type { WatchConfig } from "../src/config/schema.js";

const match = (
  l = listing,
  n = normalized,
  w: WatchConfig = watch,
  now = Date.now(),
) => evaluateMatch(l, n, w, now);

test("a listing matching keywords, filters and attribute criteria passes in one step", () => {
  assert.deepEqual(match(), { matched: true, reason: null, warnings: [] });
});

test("cheap filters reject on price range, exclusions, condition, format and seller rating", () => {
  const cases: [Partial<typeof listing>, Partial<WatchConfig>, RegExp][] = [
    [{ price: 90 }, {}, /maximum price/],
    [{ price: 5 }, { minPrice: 10 }, /minimum price/],
    [{ title: "Mouse, broken wheel" }, {}, /Excluded keyword/],
    [{ condition: "for_parts" }, {}, /condition/],
    [{ auction: true }, {}, /buying format/],
    [{ sellerPercent: 90 }, { minSellerPercent: 98 }, /seller rating/],
    [{ sellerPercent: null }, { minSellerPercent: 98 }, /seller rating/],
    [{ country: "CA" }, {}, /location/],
  ];
  for (const [l, w, reason] of cases) {
    const result = match({ ...listing, ...l }, normalized, { ...watch, ...w });
    assert.equal(result.matched, false);
    assert.match(result.reason!, reason);
  }
  // Seller rating is only a filter when the watch sets one; price is compared directly.
  assert.equal(match({ ...listing, sellerPercent: null }).matched, true);
  assert.equal(match({ ...listing, price: 85, shipping: 30 }).matched, true);
  assert.equal(
    match(
      { ...listing, auction: true, endTime: new Date(0).toISOString() },
      normalized,
      {
        ...watch,
        buying: "both",
      },
    ).reason,
    "Listing ended",
  );
});

test("auctions and buy-it-now are both watched, gated only by the buying filter", () => {
  const auction = {
    ...listing,
    auction: true,
    endTime: new Date(Date.now() + 3600000).toISOString(),
  };
  const both = match(auction, normalized, { ...watch, buying: "both" });
  assert.equal(both.matched, true);
  assert.match(both.warnings.join(), /provisional/);
  assert.equal(
    match(auction, normalized, { ...watch, buying: "auction" }).matched,
    true,
  );
  assert.equal(
    match(listing, normalized, { ...watch, buying: "auction" }).matched,
    false,
  );
});

test("extraction decides relevance and attribute criteria", () => {
  assert.match(
    match(listing, { ...normalized, matchStatus: "not_match" }).reason!,
    /Not relevant/,
  );
  assert.equal(
    match(listing, { ...normalized, matchStatus: "uncertain" }).matched,
    true,
  );
  assert.match(
    match(listing, {
      ...normalized,
      attributes: [{ key: "connectivity", value: "wired" }],
    }).reason!,
    /mismatch: connectivity/,
  );
  assert.match(
    match(listing, { ...normalized, attributes: [] }).reason!,
    /Needs verification/,
  );
  assert.match(
    match(listing, { ...normalized, confidence: 0.4 }).reason!,
    /confidence/,
  );
  const light: WatchConfig = {
    ...watch,
    constraints: [{ key: "weight_grams", operator: "lte", value: "50" }],
  };
  assert.match(match(listing, normalized, light).reason!, /outside range/);
  assert.equal(
    match(listing, normalized, {
      ...light,
      constraints: [{ key: "weight_grams", operator: "lte", value: "60" }],
    }).matched,
    true,
  );
  // No category: any keyword watch uses whatever keys it asks about.
  assert.equal(
    match(
      listing,
      { ...normalized, attributes: [{ key: "storage_gb", value: "256" }] },
      {
        ...watch,
        constraints: [{ key: "storage_gb", operator: "gte", value: "128" }],
      },
    ).matched,
    true,
  );
});
