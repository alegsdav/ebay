import { getEnv, requireValues } from "../src/config/env.js";
import { EbaySource } from "../src/connectors/ebay.js";
import { watch } from "../src/fixtures.js";
const mode = process.argv[2];
if (mode === "model") {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY in .env");
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.LLM_MODEL)}`,
    {
      headers: { "x-goog-api-key": env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok)
    throw new Error(
      `Model availability check returned HTTP ${r.status}; verify model access in AI Studio.`,
    );
  const model = await r.json();
  console.log(
    JSON.stringify(
      { name: model.name, methods: model.supportedGenerationMethods },
      null,
      2,
    ),
  );
} else if (mode === "ebay") {
  // One token request plus one search page: confirms keys and environment work.
  const env = getEnv();
  requireValues(env, [
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_POSTAL_CODE",
  ]);
  const query = process.argv.slice(3).join(" ") || "wireless gaming mouse";
  const found = [];
  for await (const l of new EbaySource({
    ...env,
    MAX_PAGES_PER_WATCH: 1,
  }).search({ ...watch, searchTerms: query, buying: "fixed" })) {
    found.push(
      `$${l.price.toFixed(2)} · ${l.condition} · ${l.title.slice(0, 70)}`,
    );
    if (found.length >= 5) break;
  }
  console.log(
    `eBay ${env.EBAY_ENV}: token OK · "${query}" returned ${found.length ? "listings" : "no listings"}\n${found.join("\n")}`,
  );
} else throw new Error("Usage: cloud-admin.ts model | ebay [search terms]");
