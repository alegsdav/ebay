import assert from "node:assert/strict";
import { Store } from "./database/store.js";
import { Pipeline } from "./scheduler/pipeline.js";
import {
  listing,
  normalized,
  watch,
  parsed,
  comparableFixtures,
} from "./fixtures.js";
import { formatAlert } from "./alerts/format.js";
const store = new Store(":memory:");
let delivered = 0;
try {
  store.createWatch("demo-user", "demo-guild", watch);
  store.importComparables(comparableFixtures());
  const pipeline = new Pipeline(
    store,
    {
      async *search() {
        yield listing;
      },
    },
    {
      model: "synthetic-fixture",
      async parseWatch() {
        return parsed;
      },
      async normalize() {
        return normalized;
      },
    },
    {
      async send(channel, payload, id) {
        delivered++;
        console.log(
          JSON.stringify(formatAlert(payload, id).embeds[0]!.toJSON(), null, 2),
        );
        return "synthetic-message";
      },
    },
    { dryRun: false, maxLlmCalls: 5 },
  );
  await pipeline.run(true);
  await pipeline.run(true);
  assert.equal(delivered, 1);
  console.log(
    "Demo passed: synthetic listing → normalization → verified fixture comps → scoring → alert; second scan produced no duplicate. No external services called.",
  );
} finally {
  store.close();
}
