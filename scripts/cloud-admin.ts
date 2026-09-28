import { getEnv } from "../src/config/env.js";
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
} else throw new Error("Usage: cloud-admin.ts model");
