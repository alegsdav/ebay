# Verified deployment status

Checked September 28, 2026.

## Deployed now

| Item                  | Status                                                                      |
| --------------------- | --------------------------------------------------------------------------- |
| Code                  | `main` at the live-monitoring release, committed, pushed and deployed       |
| Migrations            | All five applied, through `202609290001_marketplace_polling.sql`            |
| Edge Functions        | `discord-interactions` and `scout-worker` ACTIVE (redeployed 2026-09-28)    |
| Slash commands        | Registered (unchanged in the polling release)                               |
| `BRIGHT_DATA_API_KEY` | Uploaded to Supabase secrets                                                |
| Monitoring            | **On**: `CLOUD_MONITORING_ENABLED=true`, `FACEBOOK_MONITORING_ENABLED=true` |
| Dry-run               | **Off** (`DRY_RUN=false`): matches are posted to Discord                    |
| eBay                  | No credentials yet; eBay legs are skipped (`ebay_not_configured`)           |

- Supabase project: `xqbbcjnvkpstzjxytusn`. Discord application `ebay`, ID
  `1550254070189793310`, guild ID `1119082301960224930`. Interactions URL:
  `https://xqbbcjnvkpstzjxytusn.supabase.co/functions/v1/discord-interactions`.
- Verified in production: `snapshot` job kind, `scout_take_monthly_budget`,
  `scout_ingestion_runs.query_key`, and the 5-watch Marketplace cap. Unauthenticated
  calls to both functions return HTTP 401.
- Active watches: an eBay-only "Wireless Gaming Mouse" (hourly; skipped until eBay
  credentials exist) and "Lofree Flow Keyboard" (eBay + Marketplace, Campbell, CA,
  5 miles, every 90 minutes).
- First live polls (07:40–07:51 UTC): the pipeline worked end to end (trigger,
  snapshot collection, repeat skipping, Gemini relevance checks, budget accounting),
  but "campbell, ca" and "Campbell, CA" were not recognized by Facebook and returned
  Virginia/New Jersey listings. All were rejected or filtered; no wrong alert was sent.
  "Campbell, California" returned Bay Area listings, so the bot now sends full state
  names, and a batch with no listing in the watch's state is filtered
  (`brightdata_location_mismatch`).
- 07:58 UTC first "Campbell, California" search: 10 Bay Area keyboards (San Jose,
  Sunnyvale, Fremont, San Francisco, Gilroy); none were Lofree, so Gemini rejected
  all 10 and no alert was sent. 32 billed records used on the first day.
- Cron schedules unchanged.

## Live Bright Data tests (September 28, 2026)

Four capped requests (about 9 billed records): keyword search requires `city`;
"Portland" alone matched another region; "Portland, OR" with `radius` returned
Portland-area listings; an identical repeat returned three different listings, not
sorted by date, some older than the "Last 24 hours" filter. Discover-by-URL was
rejected for this account.

## Local verification

`npm run check` (42 tests, TypeScript build, both bundles), `npm run format:check`
and `npm run demo` pass. Tests cover the trigger/progress/download request shapes,
record mapping and redaction, the first-search/hourly-poll cycle with repeat skipping,
monthly budget reserve/refund/stop, single-attempt triggers, the polling migration
against PGlite, and ZIP-to-city `/defaults`.

Not yet verified in production: a scheduled Marketplace poll end to end, because
monitoring is off.

## Your next manual step

Watch Discord for match pings; see [NEXT-STEPS.md](NEXT-STEPS.md). Bright Data applies `radius`
loosely: results come from roughly the whole metro area.
