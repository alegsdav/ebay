# Verified deployment status

Checked September 28, 2026.

## Git vs. production

| Item                         | Status                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Keyword-watch rework         | Implemented, tested locally, committed and pushed to `origin/main`           |
| Migration `202609280001_...` | **Not applied** to the production project                                    |
| Edge Functions               | Production still runs the preferences release, **version 5**                 |
| Slash commands               | Production still has the old set, including `/listing evaluate`; re-register |
| Monitoring                   | Off (`CLOUD_MONITORING_ENABLED=false`), dry-run on                           |
| Facebook Marketplace         | Connector stub only; `FACEBOOK_MONITORING_ENABLED=false`                     |

A Git push is not a deployment. Deploy the migration and both functions together:
the new functions parse only the new watch shape, and the old functions cannot read
converted watches. Steps are in [NEXT-STEPS.md](NEXT-STEPS.md).

## Production (unchanged since September 24, 2026)

- Supabase project: `xqbbcjnvkpstzjxytusn`.
- Discord application `ebay`, ID `1550254070189793310`, in `test server`,
  guild ID `1119082301960224930`. No new bot or Supabase project is required.
- Edge Functions `discord-interactions` and `scout-worker` ACTIVE at version 5.
  Interactions URL:
  `https://xqbbcjnvkpstzjxytusn.supabase.co/functions/v1/discord-interactions`.
- Applied migrations: `202609170001_scout.sql`, `202609240001_classifieds.sql`,
  `202609240002_preferences.sql`.
- Worker and retention Cron schedules unchanged. `supabase/sql/schedule.sql` does not
  need re-running for the rework (`scout_cleanup_classifieds()` keeps its name).

## Local verification of the rework

- `npm run check`: typecheck, all tests, TypeScript build and both Edge Function
  bundles pass. Tests cover the new migration against PGlite (watch conversion,
  dropped tables, re-keyed normalization cache, feedback values, grants), per-source
  scanning with Marketplace disabled, match/no-match listing jobs, both-source
  defaults and opt-out, update carry-over, the Bright Data stub failing cleanly,
  Marketplace redaction, and Discord payload limits.
- `npm run demo` and `npm run format:check` pass.
- Not verified: the migration on the production database, deployed function
  behavior, live Gemini prompts after the prompt rewrite, and the Discord
  acceptance flow. No live watch, preference or provider request was created.

## Your next manual step

Deploy per [NEXT-STEPS.md](NEXT-STEPS.md), then run the Discord acceptance flow:
`/defaults`, `/watch create query:<keywords>` (preview should show both sources, no
category or pricing text, one channel), `/watch list`, `/settings`, `/watch update`,
`/watch pause|resume|delete` and `/alert test`.
