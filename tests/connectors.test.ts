import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mapItem } from "../src/connectors/ebay.js";
import { HttpError, requestJson } from "../src/connectors/http.js";
import { LlmClient } from "../src/llm/client.js";
import { Normalized, ParsedWatch } from "../src/config/schema.js";
import { normalized } from "../src/fixtures.js";
import { getEnv } from "../src/config/env.js";
import { formatAlert } from "../src/alerts/format.js";
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
test("structured schemas compile and reject unrecognized pricing fields", () => {
  assert.equal(z.toJSONSchema(Normalized).additionalProperties, false);
  assert.ok(z.toJSONSchema(ParsedWatch));
  assert.equal(
    Normalized.safeParse({ ...normalized, salePrice: 999 }).success,
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
test("Discord payload and slash definitions serialize within platform limits", () => {
  const result = formatAlert(samplePayload(), "sample-id");
  const embed = result.embeds[0]!.toJSON();
  assert.ok(embed.fields!.length <= 25);
  assert.ok(JSON.stringify(embed).length < 6000);
  assert.equal(result.components[0]!.toJSON().components.length, 5);
  assert.deepEqual(result.allowedMentions.parse, []);
  assert.ok(commands.some((c) => c.name === "watch"));
  assert.ok(commands.some((c) => c.name === "settings"));
});

test("oversized evidence and warnings stay within Discord embed limits", () => {
  const payload = samplePayload();
  payload.evaluation.comparables = payload.evaluation.comparables.map((c) => ({
    ...c,
    sourceUrl: "https://example.com/" + "a".repeat(1900),
  }));
  payload.evaluation.warnings = Array(15).fill("W".repeat(200));
  payload.evaluation.reasons = Array(3).fill("R".repeat(500));
  payload.normalized.attributes = Array(40).fill({
    key: "long-key",
    value: "V".repeat(200),
  });
  const e = formatAlert(payload, "sample").embeds[0]!.toJSON();
  assert.ok(e.fields!.every((f) => f.value.length <= 1024));
  const length =
    (e.title?.length ?? 0) +
    (e.description?.length ?? 0) +
    (e.footer?.text.length ?? 0) +
    e.fields!.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  assert.ok(length <= 6000);
});
