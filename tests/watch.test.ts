import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareWatch } from "../src/config/watch.js";
import { parsed } from "../src/fixtures.js";
import { preview } from "../src/cloud/discord.js";
import { commands } from "../src/commands/definitions.js";

const vague = {
  ...parsed,
  constraints: [],
  recommendations: [
    {
      phrase: "lightweight",
      reason: "A suggested lightweight threshold for you to confirm.",
      constraint: {
        key: "weight_grams",
        operator: "lte" as const,
        value: "50",
      },
    },
  ],
};
const prepare = () =>
  prepareWatch(vague, "lightweight gaming mouse under $20", "channel");

test("recommendations become editable draft criteria for an eBay watch", () => {
  const result = prepare();
  assert.equal(result.config.intervalMinutes, 60);
  assert.equal(result.config.maxPrice, 85);
  assert.match(result.editableQuery, /weight_grams lte 50/);
  assert.ok(
    result.config.constraints.some(
      (c) => c.key === "weight_grams" && c.value === "50",
    ),
  );
  const msg = preview(result.config, "draft", result.notes);
  assert.match(msg.content!, /Confirm recommendation/);
  assert.match(msg.content!, /50 g/);
  assert.match(msg.content!, /eBay keywords: wireless gaming mouse/);
  assert.match(msg.content!, /<#channel>/);
  assert.doesNotMatch(
    msg.content!,
    /marketplace|facebook|verified sales|profit|categor|all-in/i,
  );
  for (const c of commands as any[])
    assert.doesNotMatch(JSON.stringify(c), /defaults|sources|marketplace/i);
});

test("default exclusions do not fight the search itself", () => {
  const parts = prepareWatch(
    { ...parsed, searchTerms: "gpu for parts" },
    "gpu for parts",
    "c",
  ).config.excludedKeywords;
  assert.ok(!parts.includes("for parts"));
  assert.ok(parts.includes("broken"));
});

test("updates replace criteria but keep unstated price limits, channel and frequency", () => {
  const previous = {
    ...prepare().config,
    minPrice: 10,
    maxPrice: 40,
    channelId: "old-channel",
    intervalMinutes: 180,
  };
  const next = prepareWatch(
    {
      ...parsed,
      searchTerms: "wired gaming mouse",
      maxPrice: null,
      constraints: [],
    },
    "wired gaming mouse",
    "new-channel",
    previous,
  ).config;
  assert.equal(next.searchTerms, "wired gaming mouse");
  assert.deepEqual(next.constraints, []);
  assert.equal(next.minPrice, 10);
  assert.equal(next.maxPrice, 40);
  assert.equal(next.channelId, "old-channel");
  assert.equal(next.intervalMinutes, 180);
  const priced = prepareWatch(
    { ...parsed, maxPrice: 30 },
    "mouse under 30",
    "c",
    previous,
  ).config;
  assert.equal(priced.minPrice, null);
  assert.equal(priced.maxPrice, 30);
});

test("unresolved, uncertain, conflicting or invalid interpretations cannot be confirmed", () => {
  assert.throws(
    () =>
      prepareWatch(
        { ...vague, constraints: [vague.recommendations[0]!.constraint] },
        "mouse",
        "c",
      ),
    /conflicting/,
  );
  assert.throws(
    () =>
      prepareWatch(
        { ...parsed, clarifications: ["Which size?"] },
        "mouse",
        "c",
      ),
    /clarify/,
  );
  assert.throws(
    () => prepareWatch({ ...parsed, confidence: 0.3 }, "mouse", "c"),
    /uncertain/,
  );
  assert.throws(
    () =>
      prepareWatch(
        {
          ...vague,
          recommendations: [
            {
              ...vague.recommendations[0]!,
              constraint: {
                key: "weight_grams",
                operator: "lte",
                value: "NaN",
              },
            },
          ],
        },
        "mouse",
        "c",
      ),
    /numeric/,
  );
});
