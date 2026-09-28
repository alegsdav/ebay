# Auction Scout

A read-only Discord bot that watches free-text keywords on **eBay and Facebook Marketplace at once** and posts each new matching listing to your channel. Describe what you want, confirm Gemini's interpretation, and get one alert per matching listing. There is no category list, sold-price comparison or profit math. The bot never bids, sends offers, checks out, or handles payment credentials.

**Hosting: Supabase PostgreSQL + Edge Functions + Cron** (the only deployment target). See [verified deployment status](docs/deployment-status.md) and [your exact next steps](docs/NEXT-STEPS.md). Automated monitoring remains off and outgoing alerts remain in dry-run. The eBay leg is implemented; the Facebook Marketplace leg uses a Bright Data connector that is still a stub, so Marketplace discovery is not running yet.

## Start here

**For the current build status and your next manual action, read [NEXT-STEPS.md](docs/NEXT-STEPS.md).**

1. [Supabase hosting and database setup](docs/supabase-setup.md) — create the project, apply the migrations, configure secrets, deploy functions and schedule workers.
2. [Discord bot setup](docs/discord-setup.md) — create/invite the application, set permissions, connect the interactions endpoint, register and test commands.
3. [Gemini model research](docs/gemini-research.md) — current lifecycle findings, free-tier considerations and checking your model access.
4. [eBay API and third-party options](docs/ebay-data-options.md) — developer access and production requirements.
5. [Bright Data setup](docs/bright-data-setup.md) and [Marketplace source plan](docs/facebook-marketplace-plan.md) — the Facebook Marketplace provider and what the real adapter still needs.

The default model is `gemini-3.8-flash`. Google currently describes Gemini 2.5 as not deprecated but restricted to previous users, recommending newer models for new projects. Details and dated sources are in the Gemini guide.

## Features

- `/watch create query: lightweight gaming mouse under $20`: validated preview with keywords, sources, price range, filters and channel, a complete configuration attachment and Confirm / Edit / Cancel buttons. No watch activates before confirmation.
- One watch searches **both** eBay and Facebook Marketplace by default. The `sources` option (`eBay + Facebook Marketplace`, `eBay only`, `Facebook Marketplace only`) opts a watch out of one source. Query wording such as "on eBay" can also scope it.
- `/defaults`: save city or ZIP, radius in miles, and pickup/shipping/either per user and server. Required only for watches that include Marketplace.
- Gemini proposes numeric interpretations of vague preferences (for example “lightweight” → `weight_grams ≤ 50`) for explicit confirmation or editing.
- Simple filters: keywords, excluded terms, minimum/maximum price, condition, Buy It Now/auction/both, optional eBay seller rating, and freeform attribute criteria (`key equals|contains|lte|gte value`) checked against LLM-extracted listing details.
- `/watch list`, `/watch update`, `/watch pause`, `/watch resume`, `/watch delete`; ownership restricted to the creator and configured server. `/watch update` replaces keywords and filters; unstated sources, area and price limits carry over.
- `/settings` previews minimum/maximum price, frequency and channel changes before saving.
- Official eBay Browse keyword search/detail requests, bounded results, retries, rate-limit handling and persistent daily request budgets. Auctions and Buy It Now are both watched when the buying filter and `EBAY_ALLOW_AUCTIONS` allow.
- Durable PostgreSQL queue jobs with leases, automatic due-watch scheduling, per-source scanning (a disabled or failing source never blocks the other), normalization caching and model/prompt metadata.
- Single-tier Discord alerts: source, price or provisional current bid, condition, matched criteria, pickup area (Marketplace), seller (eBay), warnings, and auction end time.
- Reviewed / Save / Dismiss / Not relevant actions; `/listing saved`, `/listing details`, `/listing dismiss`, `/stats`, `/alert test`.
- At-most-once reservation per watch/listing. Ambiguous delivery is held for operator review rather than automatically posted twice.

## Cloud architecture

```text
Discord → signed HTTPS interaction → PostgreSQL queue → Edge Function worker
Cron → due watches → per-source keyword search jobs → fresh listing-detail jobs
     → filters → LLM extraction → keyword/attribute match → Discord alert
```

There is no persistent Discord gateway connection. Every incoming Discord request is signature-verified. The worker requires a private secret. Database tables and RPCs are inaccessible to anonymous/authenticated browser clients; server code uses the service role. Confirmation and alert reservation are atomic database operations.

`CLOUD_MONITORING_ENABLED=false` lets you test commands without polling any source. `DRY_RUN=true` allows source/model processing but suppresses match posts. `FACEBOOK_MONITORING_ENABLED=false` skips the Marketplace leg of every watch while eBay legs still run. API quotas still apply when monitoring is enabled.

## Try the offline demo

Requires Node.js 24 and npm:

```sh
npm ci
npm run check
npm run demo
```

The demo runs synthetic listings through the filters, match evaluation, alert formatting and duplicate suppression without network calls. No synthetic records are seeded into your cloud database.

`npm run check` runs TypeScript checking, tests, a TypeScript build and both Edge Function bundles. Tests include PostgreSQL migration/RPC execution through PGlite, signature validation, ownership, queue leases, budgets, per-source scanning and matching. They do not establish production access or actual Supabase cold-start latency. CI also checks formatting and the offline demo.

## Development commands

| Command                | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `npm run build:cloud`  | Bundle the two Supabase functions before deployment     |
| `npm run register`     | Register slash commands in your configured server       |
| `npm run check:model`  | Check Gemini model metadata using your account          |
| `npm run demo`         | Offline match-pipeline sanity check with synthetic data |
| `npm run format:check` | Check source/document formatting                        |

Use `.env.supabase.example` for hosted secrets and `.env.example` for the local `register`/`check:model` commands. Both populated secret files are ignored by Git.

## Scope and operating limits

V1 is US/USD only. Auctions require permitted access and explicit enablement; there are no transaction endpoints. Extracted listing details come from listing text and do not verify authenticity or condition.

Watches that include Facebook Marketplace (the default) are capped at 10 active across the deployment and run at most daily, sized to the Bright Data free-tier budget. eBay-only watches can run hourly.

The cloud scanner reads one page of up to 50 results per source, queues up to `CLOUD_ITEMS_PER_WATCH` plausible new candidates per source (20 by default), and retries up to 10 previously failed candidates per watch. It is a bounded monitor, not an exhaustive feed. Narrow watches and inspect backlog, call budgets and database usage.

Relist similarity deduplication, digest aggregation, repeat near-end alerts, automatic rule learning and administrative notifications remain follow-up work. See [design](docs/design.md) and [Supabase operations](docs/supabase-setup.md) for recovery and deployment limitations.
