# Verified deployment status

Checked September 28, 2026.

## Deployed now

| Item                  | Status                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| Code                  | `main` at the Bright Data polling release, committed, pushed and deployed      |
| Migrations            | All five applied, through `202609290001_marketplace_polling.sql`               |
| Edge Functions        | `discord-interactions` and `scout-worker` ACTIVE at **version 7**              |
| Slash commands        | Registered (unchanged in the polling release)                                  |
| `BRIGHT_DATA_API_KEY` | Uploaded to Supabase secrets                                                   |
| Monitoring            | **Off**: `CLOUD_MONITORING_ENABLED=false`, `FACEBOOK_MONITORING_ENABLED` unset |
| Dry-run               | On (`DRY_RUN=true`)                                                            |
| eBay                  | No credentials yet; eBay legs are skipped (`ebay_not_configured`)              |

- Supabase project: `xqbbcjnvkpstzjxytusn`. Discord application `ebay`, ID
  `1550254070189793310`, guild ID `1119082301960224930`. Interactions URL:
  `https://xqbbcjnvkpstzjxytusn.supabase.co/functions/v1/discord-interactions`.
- Verified in production: `snapshot` job kind, `scout_take_monthly_budget`,
  `scout_ingestion_runs.query_key`, and the 5-watch Marketplace cap. Unauthenticated
  calls to both functions return HTTP 401.
- Active watches: an eBay-only "Wireless Gaming Mouse" (hourly) and "Lofree Flow
  Keyboard" (eBay + Marketplace, Campbell, CA, 5 miles, still at the old daily
  1440-minute interval).
- Cron schedules unchanged.

## Live Bright Data tests (September 28, 2026)

Four capped requests (about 9 billed records): keyword search requires `city`;
"Portland" alone matched another region; "Portland, OR" with `radius` returned
Portland-area listings; an identical repeat returned three different listings, not
sorted by date, some older than the "Last 24 hours" filter. Discover-by-URL was
rejected for this account.

## Local verification

`npm run check` (38 tests, TypeScript build, both bundles), `npm run format:check`
and `npm run demo` pass. Tests cover the trigger/progress/download request shapes,
record mapping and redaction, the first-search/hourly-poll cycle with repeat skipping,
monthly budget reserve/refund/stop, single-attempt triggers, the polling migration
against PGlite, and ZIP-to-city `/defaults`.

Not yet verified in production: a scheduled Marketplace poll end to end, because
monitoring is off.

## Your next manual step

Decide when to turn monitoring on (see [NEXT-STEPS.md](NEXT-STEPS.md)).
