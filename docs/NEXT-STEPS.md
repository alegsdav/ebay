# Your next steps — cross-source keyword watches

Updated September 28, 2026. This replaces the earlier Marketplace-only and
manual-listing plans.

## What changed in the keyword-watch rework

The bot now watches free-text keywords on eBay and Facebook Marketplace at once
and posts each new matching listing to the watch's channel. Removed: the fixed
six-category list, sold-price comparables, fee/profit/discount math, the
strong/possible two-tier alerts, `/listing evaluate` manual submissions, and the
local SQLite/gateway bot.

- `/watch create query:<keywords and filters>` searches **both** sources by default.
  Use `sources:eBay only` or `sources:Facebook Marketplace only` to opt out of one.
- Filters: excluded terms, minimum/maximum price, condition, Buy It Now/auction/both,
  optional eBay seller rating, and attribute criteria Gemini extracts from the
  query (for example `weight_grams ≤ 50` for “lightweight”, which you confirm or edit).
- A listing alerts when it passes the filters, Gemini judges it relevant to the
  search, and its extracted details satisfy the attribute criteria. One alert per
  watch/listing, no pricing analysis.
- `/defaults` (city or ZIP, radius, delivery) is required only when a watch includes
  Marketplace. eBay-only watches need no location.
- `/settings` now edits minimum/maximum price, frequency and channel.
  `/watch update` replaces keywords/filters but keeps unstated sources, area and
  price limits.
- Watches that include Marketplace: at most 10 active deployment-wide and at most
  daily. Since Marketplace is on by default, pick `eBay only` for hourly watches.
- Existing watches are converted by the new migration: sold-price thresholds are
  dropped and an asking-price or all-in budget becomes the maximum price.

## What is NOT running yet

- Deployed September 28, 2026 (migration applied, functions version 6, commands
  re-registered); see [deployment-status.md](deployment-status.md).
- **Facebook Marketplace discovery.** `src/connectors/brightdata.ts` is a stub:
  Bright Data's keyword-search request/response shape is not captured yet. Keep
  `FACEBOOK_MONITORING_ENABLED=false`; the Marketplace leg of each watch is skipped
  and its eBay leg runs normally.
- Monitoring stays OFF (`CLOUD_MONITORING_ENABLED=false`) and dry-run stays ON.

## Your next manual actions

1. **Acceptance test in Discord:** `/defaults zipcode:YOUR_ZIP radius:25 delivery:pickup`,
   then `/watch create query:lightweight gaming mouse under 20 bucks`. The preview should
   show `eBay + Facebook Marketplace`, a price limit, no category or pricing text, and
   one channel. Confirm, then check `/watch list`, `/settings`, `/watch update`,
   `/watch pause|resume|delete` and `/alert test` (single-tier embed).

2. **Capture the Bright Data contract** (Bright Data now has $5 of usable credit; do not
   add funds or auto-recharge). In the dashboard, open **Web Scraper API → Facebook
   Marketplace → Collect listings by keyword**, and save privately: the dataset ID
   (`BRIGHT_DATA_DATASET_ID`), the generated request with its bearer token removed,
   and one small redacted sample response. Run the smallest result count only. See
   [bright-data-setup.md](bright-data-setup.md).

Share the sanitized request and sample response. The next engineering step is the
real `BrightDataSource.search()` against that contract, then a narrow dry-run test
watch with `FACEBOOK_MONITORING_ENABLED=true`.

## Free-tier sizing

[Bright Data's Marketplace page](https://brightdata.com/products/web-scraper/facebook/marketplace)
advertises free records per month; this is not a count of searches, and credits may
be shared with other Bright Data products. Confirm the actual balance in your account.

Proposed steady-state allocation: **10 watches × 15 returned records × 31 days =
4,650 records/month**. A strict record budget must stop requests before the allowance
or credit is exhausted, including test traffic and retries. The per-day call cap
(`BRIGHT_DATA_MAX_CALLS_PER_DAY`, default 10) is a coarse guard, not a record budget.
