# Verified deployment status

Checked September 24, 2026 (Pacific time), preferences release.

## Deployed now

- Existing Supabase project: `xqbbcjnvkpstzjxytusn`.
- Existing Discord application `ebay`, ID `1550254070189793310`, in `test server`,
  guild ID `1119082301960224930`. No new bot or Supabase project is required.
- Both Edge Functions are ACTIVE at **version 5**: `discord-interactions` and
  `scout-worker`. The interactions URL is unchanged:
  `https://xqbbcjnvkpstzjxytusn.supabase.co/functions/v1/discord-interactions`.
- Applied `202609240002_preferences.sql` after the two existing migrations:
  private per-user/server defaults, global 10-active-Marketplace-watch cap, and
  minimum daily search interval enforced on creates, updates, and resumes.
- Registered `/defaults`, `/watch`, `/listing`, `/alert`, `/stats`, `/settings`.
- Gemini's prompt now returns proposed numeric interpretations for confirmation.
  Edit query is prefilled with the proposed threshold so it can be changed directly.
- New watches default to Facebook Marketplace match-only criteria. Existing eBay
  watches and older optional research commands are preserved.
- Monitoring remains disabled and dry-run remains enabled. The existing worker
  and retention schedules are unchanged. Bright Data is not connected.

## Verification

- 45 tests passed, including SQLite and PostgreSQL preference privacy, draft
  confirmation ownership, 10-watch enforcement, resume enforcement, daily cadence,
  explicit overrides, invalid recommendations, and Discord command definitions.
- TypeScript checking, Node build, and both cloud bundles passed.
- Read back the live Discord command registration: `/defaults` exposes `city`,
  `zipcode`, `radius`, and `delivery`. Authenticated worker smoke test returned
  HTTP 200 with `idle: true`; unsigned interactions still return HTTP 401.
- Two live Gemini requests passed: “lightweight gaming mouse under 20 bucks”
  proposed `weight_grams lte 50`, asking price $20; editing the criterion to 60
  produced `weight_grams lte 60` with no repeated recommendation.
- No test watch or preference was saved in the live database. Your next Discord
  commands are the user-driven end-to-end acceptance test, not a test already run.

## Your next manual step

Run `/defaults zipcode:YOUR_ZIP radius:25 delivery:pickup` in the existing server,
then `/watch create query:lightweight gaming mouse under 20 bucks`. Review the
suggestion, edit or confirm, and check `/watch list`.

This confirms preferences only. **Automatic Facebook discovery and real matching
pings are NOT implemented yet.** They need the Bright Data keyword-search adapter,
monthly record budget enforcement, match-only evaluation and delivery validation.
You do not need `/listing evaluate` or sold-price evidence for the intended workflow.

Next, create a free Bright Data account and store its API token privately. Follow
the exact account, free-budget and sanitized request-example instructions in
[NEXT-STEPS.md](NEXT-STEPS.md). Do not enable monitoring or add paid funds yet.
