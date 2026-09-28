# Local Node/SQLite operation

For the primary hosted deployment, use [Supabase setup and operations](supabase-setup.md). This document describes only the optional local process.

## Host and scheduler

Use one bot process on Node 24 with a persistent local disk. The Discord gateway needs a continuously running process; a sleeping web-service free tier or an hourly GitHub Actions runner cannot also provide an always-connected command bot with local SQLite. GitHub Actions here runs CI only.

The process starts an hourly scheduler. A database lease excludes concurrent scans and expires after 50 minutes after a crash; a scan stops taking new work after 40 minutes. Stop/restart is graceful. No monitoring happens while the machine sleeps. Use your OS service manager or the included Docker Compose service for restart behavior.

```sh
docker compose up --build -d
docker compose logs -f bot
```

Do not run a second container against the same SQLite volume. Local `npm run scan` should point at the same database only when deliberate; the lease protects scans, and shared daily counters protect configured request budgets. Daily counters reset at midnight UTC. Retries count as requests. Provider-side usage from other applications is outside these counters.

## Daily review

Check `bot_started`, `scan_completed`, `search_truncated`, `llm_failure`, `watch_scan_failure`, `listing_failure` and `alert_delivery_unknown` events. Logs intentionally omit credentials, raw provider errors, titles and prompts. They include IDs, error class and applicable status metadata. Use `/stats`, `/watch list` and `/listing details` for your records. The original fields, normalized output, evidence, model and prompt version are stored in SQLite.

`DRY_RUN=true` prevents outgoing opportunity posts and does not reserve alert IDs or move the successful live scan timestamp. It still performs authorized API/model calls. Discord setup/test responses are interactive responses to commands, not opportunity alerts.

## Failure handling

- HTTP 429: no immediate retry; honor Retry-After. Daily budget exhaustion holds new calls until the next UTC day.
- Network and HTTP 5xx: bounded exponential backoff, at most three attempts, 20-second request timeout.
- LLM malformed/refused/incomplete output: no price estimate from that response; retain candidate as `needs_processing` and retry on a future scheduled scan. Low-confidence extraction below 0.65 is not cached.
- eBay removed/404/410 items: mark unavailable when refreshing details. Unknown shipping/location/condition and expired auctions are ineligible.
- Incorrect match: use the button, pause the watch if needed, inspect evidence and refine the query. Feedback is recorded; V1 does not silently learn or mutate rules.
- Discord send ambiguity: alert remains `delivery_unknown` (or `sending` if the process died). Automatic resend is suppressed. Search the channel for the alert ID in the footer; if found, record the message ID and `sent` status. Only an operator who has verified no message exists should delete that reservation to allow a later send. This trades possible missed delivery for duplicate protection.
- Changed watch during a scan: revision is checked before alert reservation; a changed or paused watch is reconsidered on the next scan. A message already in flight cannot be recalled.

## Backups

Stop the bot before copying `data/scout.sqlite` plus any adjacent WAL/SHM files, or use SQLite's online backup mechanism. Keep backups outside the repository and protect them: watches, Discord user IDs and source evidence are user data. Docker stores the database in the `scout-data` named volume. Back up that volume before moving hosts or removing volumes. Do not use `docker compose down -v` unless you intend to erase the database.

## Scope and limits

- US/USD only. Templates start with one marketplace category each; sneaker search currently uses the men's athletic-shoe category. Expand validated taxonomy mappings for other subcategories.
- Auctions require `EBAY_ALLOW_AUCTIONS=true` and appropriate authorized access. The flag is an operator assertion, not a grant of eBay permission. Fixed-price is the default. No bidding endpoints are implemented.
- Search reads at most `MAX_PAGES_PER_WATCH` pages of 50 newest results. Broad watches may miss items beyond that cap; `search_truncated` makes this visible. Narrow your watches rather than treating the feed as exhaustive.
- Refresh considers up to 100 previously silent/pending candidates per watch, oldest processing time first. No more than one alert per watch/listing is sent. Near-ending repeat alerts, relist similarity deduplication and cross-watch digest aggregation are not implemented.
- Exact comparable matching deliberately favors fewer, better-supported alerts. Missing receiver/revision/accessory evidence can mean no matches. Photo inspection, authenticity checks and a canonical product specification service are not implemented.
- Tax, platform fees and reserves are configurable estimates, not jurisdiction- or platform-certified calculations. The maximum sensible bid is a modeled cap, not an instruction to bid. An all-in cap below unavoidable shipping/fees yields a zero maximum purchase amount.
- SQLite is the implemented database. The Supabase deployment now has a separate PostgreSQL adapter and durable workers. Automated backups, provider sold-history adapters and administrative error notifications are follow-up work. Operational errors are currently logged locally.
