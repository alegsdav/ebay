import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
for (const [name, handler] of [
  ["discord-interactions", "interactionsHandler"],
  ["scout-worker", "workerHandler"],
]) {
  const source = `import {cloudConfig,${handler}} from './src/cloud/handlers.ts';\nconst config=cloudConfig(Deno.env.toObject());\nDeno.serve(${handler}(config${handler === "interactionsHandler" ? ", promise => EdgeRuntime.waitUntil(promise)" : ""}));\n`;
  await mkdir(`supabase/functions/${name}`, { recursive: true });
  await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    outfile: `supabase/functions/${name}/index.ts`,
    minify: false,
    legalComments: "none",
  });
}
console.log(
  "Built self-contained Edge Functions; no node:sqlite or Discord gateway runtime.",
);
