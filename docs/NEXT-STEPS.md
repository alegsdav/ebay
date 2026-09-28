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
- Watches that include Marketplace: at most 5 active (testing cap), checked every 90 minutes by default (hourly minimum).
  The first search returns up to 10 current listings; later polls ask for 2 recent
  ones. Listings already seen are never re-notified (but Bright Data still bills them).
- Existing watches are converted by the new migration: sold-price thresholds are
  dropped and an asking-price or all-in budget becomes the maximum price.

## Current state

- Deployed and **live** since September 28, 2026: monitoring on, dry-run off, so
  matching Marketplace listings are pinged in the watch's channel.
- eBay has no API credentials, so eBay legs are skipped until you add them.
- Bright Data needs cities with full state names ("Campbell, California"); the bot
  converts "Campbell, CA" automatically. Results cover roughly the whole metro area,
  not the exact radius.
- Facebook's keyword search is fuzzy: a "lofree flow keyboard" search returns many
  generic keyboards. Gemini rejects those, so pings only come for real matches.

## Your next manual actions

1. Watch your alert channel. If a ping is not what you want, press **Not relevant**
   and tighten the watch with `/watch update`.
2. Set a monthly spend limit in the Bright Data dashboard as a backstop; do not enable
   auto-recharge.
3. To pause everything: `npx supabase secrets set CLOUD_MONITORING_ENABLED=false`, or
   `/watch pause` for one watch.

## Budget

Pay-as-you-go is $1.50 per 1,000 records; Bright Data advertises 5,000 free records per
month. Every returned record counts, repeats included. At the defaults one watch uses
about 970 records a month (10 on the first search, then 2 per poll every 90 minutes);
5 watches need about 4,850. `BRIGHT_DATA_MAX_RECORDS_PER_MONTH` (default 4,500)
stops Marketplace polling for the rest of the UTC month once reached.

Search results are not sorted by date and vary between identical searches, so 2 records
per hour may miss some new listings. If that happens, raise `BRIGHT_DATA_POLL_RECORDS`
or ask Bright Data to enable discover-by-URL (search URL sorted newest first).
