import assert from "node:assert/strict";
import { listing, normalized, watch } from "./fixtures.js";
import { evaluateMatch } from "./filters/evaluate.js";
import { basicReject } from "./filters/matches.js";
import { alertMessage } from "./cloud/discord.js";
// Offline sanity check of the match pipeline: synthetic listings, no network,
// and the same at-most-once-per-watch/listing rule the database reservation enforces.
const reserved = new Set<string>();
let delivered = 0;
function scan(candidates: (typeof listing)[]) {
  for (const l of candidates) {
    if (basicReject(l, watch)) continue;
    const match = evaluateMatch(l, normalized, watch);
    if (!match.matched) continue;
    const key = `demo-watch:${l.id}`;
    if (reserved.has(key)) continue;
    reserved.add(key);
    delivered++;
    const message = alertMessage(
      { listing: l, normalized, match, config: watch },
      `demo-${delivered}`,
    );
    console.log(JSON.stringify(message.embeds![0], null, 2));
  }
}
const excluded = {
  ...listing,
  id: "synthetic-broken",
  title: `${listing.title} (broken)`,
};
const expensive = { ...listing, id: "synthetic-expensive", price: 120 };
scan([listing, excluded, expensive]);
scan([listing, excluded, expensive]);
assert.equal(delivered, 1);
console.log(
  "Demo passed: synthetic listing → filters → extraction → keyword/attribute match → alert; excluded and over-budget listings stayed silent and the second scan produced no duplicate. No external services called.",
);
