# Verified deployment status

Checked September 28, 2026.

## Deployed now (September 28, 2026)

| Item                         | Status                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Keyword-watch rework         | Committed, pushed and deployed                                     |
| Migration `202609280001_...` | Applied to `xqbbcjnvkpstzjxytusn`                                  |
| Edge Functions               | `discord-interactions` and `scout-worker` ACTIVE at **version 6**  |
| Slash commands               | Re-registered; `/listing evaluate` removed, `sources` option added |
| Monitoring                   | Off (`CLOUD_MONITORING_ENABLED=false`), dry-run on                 |
| Facebook Marketplace         | Connector stub only; `FACEBOOK_MONITORING_ENABLED` unset (= false) |
| Secrets                      | Unchanged; new Bright Data variables fall back to defaults         |

- Supabase project: `xqbbcjnvkpstzjxytusn`. Discord application `ebay`, ID
  `1550254070189793310`, guild ID `1119082301960224930`. Interactions URL:
  `https://xqbbcjnvkpstzjxytusn.supabase.co/functions/v1/discord-interactions`.
- Applied migrations: `202609170001`, `202609240001`, `202609240002`, `202609280001`.
- The one existing watch (an older eBay-style watch) was converted: sources
  `ebay`, maximum price $20, hourly, revision 2. The dropped comparable,
  submission and evaluation tables were empty.
- Deployment smoke test: unsigned interactions and anonymous worker calls return
  HTTP 401 from the new functions, which confirms they booted with production secrets.
- Cron schedules unchanged; `supabase/sql/schedule.sql` did not need re-running.

## Local verification of the rework

- `npm run check`: typecheck, all tests, TypeScript build and both Edge Function
  bundles pass. Tests cover the new migration against PGlite (watch conversion,
  dropped tables, re-keyed normalization cache, feedback values, grants), per-source
  scanning with Marketplace disabled, match/no-match listing jobs, both-source
  defaults and opt-out, update carry-over, the Bright Data stub failing cleanly,
  Marketplace redaction, and Discord payload limits.
- `npm run demo` and `npm run format:check` pass.
- Not verified: live Gemini prompts after the prompt rewrite and the Discord
  acceptance flow. No live watch, preference or provider request was created.

## Your next manual step

Run the Discord acceptance flow:
`/defaults`, `/watch create query:<keywords>` (preview should show both sources, no
category or pricing text, one channel), `/watch list`, `/settings`, `/watch update`,
`/watch pause|resume|delete` and `/alert test`.
