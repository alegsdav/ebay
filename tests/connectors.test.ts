import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mapItem } from "../src/connectors/ebay.js";
import { HttpError, requestJson } from "../src/connectors/http.js";
import { LlmClient } from "../src/llm/client.js";
import { Normalized, ParsedWatch } from "../src/config/schema.js";
import { normalized } from "../src/fixtures.js";
import { getEnv } from "../src/config/env.js";
import { alertMessage } from "../src/cloud/discord.js";
import { samplePayload } from "../src/fixtures.js";
import { commands } from "../src/commands/definitions.js";
const item = {
  itemId: "v1|123|0",
  itemWebUrl: "https://www.ebay.com/itm/123",
  title: "Mouse",
  price: { value: "90", currency: "USD" },
  currentBidPrice: { value: "30", currency: "USD" },
  buyingOptions: ["AUCTION"],
  conditionId: "1500",
  itemLocation: { country: "US" },
  seller: { feedbackPercentage: "99.8", feedbackScore: 50 },
  shippingOptions: [],
};
test("auction mapping uses current bid, preserves missing shipping, rejects unknown bid", () => {
  const l = mapItem(item);
  assert.equal(l.price, 30);
  assert.equal(l.shipping, null);
  assert.equal(l.condition, "open_box");
  assert.throws(() => mapItem({ ...item, currentBidPrice: undefined }));
  assert.throws(() =>
    mapItem({ ...item, itemWebUrl: "https://evil.example/steal" }),
  );
  assert.equal(
    mapItem({
      ...item,
      shippingOptions: [{ shippingCost: { currency: "USD", value: "0" } }],
    }).shipping,
    0,
  );
});
test("rate limiting honors Retry-After without extra calls", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", {
      status: 429,
      headers: { "Retry-After": "3600" },
    });
  });
  await assert.rejects(
    requestJson("https://example.com", {}, "test-limit"),
    HttpError,
  );
  await assert.rejects(
    requestJson("https://example.com", {}, "test-limit"),
    HttpError,
  );
  assert.equal(calls, 1);
});
test("structured schemas compile and reject removed category/pricing fields", () => {
  assert.equal(z.toJSONSchema(Normalized).additionalProperties, false);
  assert.ok(z.toJSONSchema(ParsedWatch));
  for (const extra of [
    { salePrice: 999 },
    { category: "gaming_mice" },
    { comparableSearchTerms: [] },
  ])
    assert.equal(
      Normalized.safeParse({ ...normalized, ...extra }).success,
      false,
    );
});
test("Gemini structured output is locally validated and malformed/refused responses rejected", async (t) => {
  const env = {
    ...getEnv(),
    LLM_PROVIDER: "gemini" as const,
    GEMINI_API_KEY: "fake-test-key",
  };
  const llm = new LlmClient(env);
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify(normalized) }] },
        },
      ],
    });
  });
  assert.deepEqual(
    await llm.structured(Normalized, "test", "extract", {}),
    normalized,
  );
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(
    body.generationConfig.responseJsonSchema.additionalProperties,
    false,
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: '{"bad":true}' }] },
        },
      ],
    }),
  );
  await assert.rejects(llm.structured(Normalized, "test", "extract", {}));
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      candidates: [
        { finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } },
      ],
    }),
  );
  await assert.rejects(llm.structured(Normalized, "test", "extract", {}));
});
test("OpenAI Responses structured output and refusals", async (t) => {
  const llm = new LlmClient({
    ...getEnv(),
    LLM_PROVIDER: "openai",
    LLM_MODEL: "test-model",
    OPENAI_API_KEY: "fake-test-key",
  });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      status: "completed",
      output: [
        {
          content: [{ type: "output_text", text: JSON.stringify(normalized) }],
        },
      ],
    }),
  );
  assert.deepEqual(
    await llm.structured(Normalized, "test", "extract", {}),
    normalized,
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      status: "completed",
      output: [{ content: [{ type: "refusal", refusal: "No" }] }],
    }),
  );
  await assert.rejects(llm.structured(Normalized, "test", "extract", {}));
});
const embedLength = (e: any) =>
  (e.title?.length ?? 0) +
  (e.description?.length ?? 0) +
  (e.footer?.text.length ?? 0) +
  e.fields.reduce(
    (sum: number, f: any) => sum + f.name.length + f.value.length,
    0,
  );
test("Discord payload and slash definitions serialize within platform limits", () => {
  const result = alertMessage(samplePayload(), "sample-id");
  const embed = result.embeds![0];
  assert.ok(embed.fields.length <= 25);
  assert.ok(JSON.stringify(embed).length < 6000);
  assert.equal(result.components![0].components.length, 5);
  assert.ok(commands.some((c) => c.name === "watch"));
  const watch: any = commands.find((c) => c.name === "watch");
  assert.deepEqual(
    watch.options
      .find((o: any) => o.name === "create")
      .options.map((o: any) => o.name),
    ["query", "channel"],
  );
  const listing: any = commands.find((c) => c.name === "listing");
  assert.ok(!listing.options.some((o: any) => o.name === "evaluate"));
  const settings: any = commands.find((c) => c.name === "settings");
  assert.deepEqual(
    settings.options.map((o: any) => o.name),
    [
      "id",
      "min_price",
      "max_price",
      "clear_price_limits",
      "frequency",
      "channel",
    ],
  );
  for (const c of commands as any[]) {
    assert.ok(c.description.length <= 100);
    for (const o of c.options ?? []) {
      assert.ok(o.description.length <= 100);
      for (const p of o.options ?? []) assert.ok(p.description.length <= 100);
    }
  }
});

test("oversized text, warnings and attributes stay within Discord embed limits", () => {
  const payload = samplePayload();
  payload.listing.title = "T".repeat(500);
  payload.listing.sellerName = "S".repeat(200);
  payload.match.warnings = Array(15).fill("W".repeat(200));
  payload.normalized.explanation = "E".repeat(500);
  payload.normalized.attributes = Array.from({ length: 40 }, (_, i) => ({
    key: i ? `key_${i}` : "connectivity",
    value: "V".repeat(200),
  }));
  payload.config.constraints = [];
  const e = alertMessage(payload, "sample").embeds![0];
  assert.ok(e.fields.every((f: any) => f.value.length <= 1024));
  assert.ok(e.title.length <= 256);
  assert.ok(embedLength(e) <= 6000);
});
