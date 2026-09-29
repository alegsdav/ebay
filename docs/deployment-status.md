# Verified deployment status

Checked September 28, 2026 (Pacific).

## Deployed now

| Item                   | Status                                                               |
| ---------------------- | -------------------------------------------------------------------- |
| Code                   | eBay-only release, committed, pushed and deployed                    |
| Migrations             | All applied, through `202609300001_remove_marketplace.sql`           |
| Edge Functions         | `discord-interactions` and `scout-worker` ACTIVE                     |
| Slash commands         | Re-registered: `/watch`, `/listing`, `/alert`, `/stats`, `/settings` |
| Monitoring             | On (`CLOUD_MONITORING_ENABLED=true`), dry-run off (`DRY_RUN=false`)  |
| eBay                   | **No credentials yet**: scans do nothing until the eBay keys are set |
| Debug channel          | `#debug-console` (`DEBUG_CHANNEL_ID=1554167190230536292`)            |
| Facebook / Bright Data | Removed: code, secrets, tables, functions and stored listings/alerts |

- Supabase project: `xqbbcjnvkpstzjxytusn`. Discord application `ebay`, ID
  `1550254070189793310`, guild ID `1119082301960224930`. Interactions URL:
  `https://xqbbcjnvkpstzjxytusn.supabase.co/functions/v1/discord-interactions`.
- Active watches (eBay-only): "Lofree Flow Keyboard" (every 90 minutes) and "HD 560S".
- The retention Cron job was re-created from `supabase/sql/schedule.sql` without the
  removed cleanup function. Unauthenticated calls to both functions return HTTP 401.

## Local verification

`npm run check` (25 tests, TypeScript build, both bundles), `npm run format:check` and
`npm run demo` pass. The migration test applies the full chain against PGlite and
checks watch conversion, Marketplace data and table removal, and service-only grants.

Not yet verified: any live eBay request (no keys yet).

## Your next manual step

Add the eBay keys (see [NEXT-STEPS.md](NEXT-STEPS.md)).
