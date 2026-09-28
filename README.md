# Auction Scout

A read-only Discord bot being adapted for automatic Facebook Marketplace matching: describe what you want, confirm Gemini's interpretation, and receive matching listings in Discord. `/defaults` and editable interpretation previews are implemented; automatic Bright Data discovery and match pings are still pending. The older eBay deal-research path remains available. The bot never bids, sends offers, checks out, or handles payment credentials.

**Primary hosting: Supabase PostgreSQL + Edge Functions + Cron.** The existing project and bot are already configured. See [verified deployment status](docs/deployment-status.md) and [your exact next steps](docs/NEXT-STEPS.md). Automated monitoring remains off and outgoing alerts remain in dry-run. Sold prices, resale analysis, and manual listing submission are NOT requirements for the new Marketplace workflow.

## Start here

**For the current build status and your next manual action, read [NEXT-STEPS.md](docs/NEXT-STEPS.md).**

1. [Supabase hosting and database setup](docs/supabase-setup.md) — create the project, apply the migration, configure secrets, deploy functions and schedule workers.
2. [Discord bot setup](docs/discord-setup.md) — create/invite the application, set permissions, connect the interactions endpoint, register and test commands.
3. [Gemini model research](docs/gemini-research.md) — current lifecycle findings, free-tier considerations and checking your model access.
4. [eBay API and third-party options](docs/ebay-data-options.md) — developer access, production requirements, free alternatives and sold-data limitations.
5. [Comparable record format](docs/comparables.md) — import verified evidence into Supabase.

The default model is `gemini-3.8-flash`. Google currently describes Gemini 2.5 as not deprecated but restricted to previous users, recommending newer models for new projects. Details and dated sources are in the Gemini guide.

## Features

- `/defaults`: save city or ZIP, radius in miles, and pickup/shipping/either per user and server. Gemini proposes numeric interpretations of vague preferences for explicit confirmation or editing. New Marketplace watches are match-only, capped at 10 active watches and a daily minimum interval; discovery remains disconnected.
- `/listing evaluate`: privately preview and confirm manually entered Facebook Marketplace facts against an existing category watch. Includes pickup travel costs, independent sold evidence and conservative confidence limits; no Facebook requests. See the [Marketplace implementation and rollout notes](docs/facebook-marketplace-plan.md). Screenshot extraction and managed-provider monitoring are not enabled.
- `/watch create query: lightweight gaming mice`: validated structured preview, complete configuration attachment and Confirm / Edit / Cancel buttons. No watch activates before confirmation.
- `/watch list`, `/watch update`, `/watch pause`, `/watch resume`, `/watch delete`; ownership restricted to the creator and configured server.
- `/settings` previews threshold, comparable-policy, frequency and destination changes before saving.
- Six category templates: gaming mice, graded Pokémon cards, GPUs, camera lenses, sneakers and power tools. Template category IDs are checked against eBay Taxonomy; the LLM cannot invent them.
- Official Browse search/detail requests, bounded results, retries, source rate-limit handling and persistent daily request budgets.
- Durable PostgreSQL queue jobs with leases, automatic due-watch scheduling, normalization caching and model/prompt metadata.
- Strict category-aware sold-price matching. Unknown identity fields never match other unknowns; missing shipping or explicit watch requirements prevents a deal alert.
- Deterministic integer-cent pricing: all-in cost, delivered-sale median/range, selling fees, shipping, risk reserve, profit, discount and a modeled maximum bid/purchase price.
- Discord alerts with source/evidence links, confidence, warnings and provisional auction labels. Possible matches use an optional separate channel.
- Reviewed / Save / Dismiss / Not a match actions; `/listing saved`, `/listing details`, `/listing dismiss`, `/stats`, `/alert test`.
- At-most-once reservation per watch/listing. Ambiguous delivery is held for operator review rather than automatically posted twice.

## Cloud architecture

```text
Discord → signed HTTPS interaction → PostgreSQL queue → Edge Function worker
Cron → due watches → bounded search jobs → fresh listing-detail jobs
     → LLM extraction → verified-sale matching → pricing → Discord alert
```

There is no persistent Discord gateway connection in the hosted deployment. Every incoming Discord request is signature-verified. The worker requires a private secret. Database tables and RPCs are inaccessible to anonymous/authenticated browser clients; server code uses the service role. Confirmation and alert reservation are atomic database operations.

`CLOUD_MONITORING_ENABLED=false` lets you test commands without polling eBay. `DRY_RUN=true` allows source/model processing but suppresses opportunity posts. Neither switch turns a live scan into a free offline demo; API quotas still apply when monitoring is enabled.

## Try the offline demo

Requires Node.js 24 and npm:

```sh
npm ci
npm run check
npm run demo
```

The demo uses an in-memory database and explicitly synthetic listings/sales. It exercises pricing, alert formatting and duplicate suppression without network calls. No synthetic records are seeded into your cloud database.

`npm run check` runs TypeScript checking, tests, a local build and both Edge Function bundles. Tests include PostgreSQL migration/RPC execution through PGlite, signature validation, ownership, queue leases, budgets and pricing. They do not establish production access or actual Supabase cold-start latency. CI also checks formatting and the offline demo.

## Development commands

| Command                              | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `npm run build:cloud`                | Bundle the two Supabase functions before deployment           |
| `npm run register`                   | Register slash commands in your configured server             |
| `npm run import:cloud -- sales.json` | Import verified completed sales into Supabase                 |
| `npm run check:model`                | Check Gemini model metadata using your account                |
| `npm run format:check`               | Check source/document formatting                              |
| `npm run dev`                        | Optional local gateway bot with SQLite; not the Supabase host |
| `npm run scan`                       | Optional local one-shot scan; respects local dry-run settings |

Use `.env.supabase.example` for hosted secrets and `.env.example` for local commands. Both populated secret files are ignored by Git. See [local operations](docs/operations.md) only if choosing the optional Node/SQLite process or Docker development path. Local and cloud databases are separate.

## Scope and operating limits

V1 is US/USD only. The sneaker template currently targets the men's athletic-shoe category. Auctions require permitted access and explicit enablement; there are no transaction endpoints. Pricing assumptions must be reviewed for your situation and do not verify authenticity or guarantee resale value.

The cloud scanner reads one page of up to 50 source results, queues up to `CLOUD_ITEMS_PER_WATCH` plausible new candidates (20 by default), and refreshes up to 10 previous unresolved candidates per watch. It is a bounded monitor, not an exhaustive eBay feed. Comparable lookup is bounded at 1,000 records per category/lookback; very large datasets need item-indexed retrieval before expanding coverage. Narrow watches and inspect backlog, call budgets and database usage.

Sold records are imported from permitted, verified sources. No comprehensive free sold-history provider is assumed or integrated. Relist similarity deduplication, digest aggregation, repeat near-end alerts, automatic rule learning and administrative notifications remain follow-up work. See [design](docs/design.md) and [Supabase operations](docs/supabase-setup.md) for recovery and deployment limitations.
