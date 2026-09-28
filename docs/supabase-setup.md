# Supabase hosting and database setup

Supabase is the primary hosted deployment target. The repository includes PostgreSQL tables, service-only access controls, atomic queue/confirmation functions, two Edge Functions and a Cron schedule. **Your existing project is now deployed; see [deployment status](deployment-status.md) for completed setup and your next test.** The instructions below describe setup for a new project and future updates.

## How hosting works

```text
Discord → signed HTTPS interaction → PostgreSQL job queue → Edge Function worker
Supabase Cron → worker pulses → due watches → eBay search jobs → listing jobs
Listing job → fresh eBay detail → Gemini → comparable matching → Discord alert
```

This replaces the local Discord gateway process and SQLite for hosted operation. You do not run `npm start` on a server. Local SQLite and the offline demo remain available for development; they do not sync with Supabase automatically.

The worker handles **one durable job per invocation**, with an application deadline of 95 seconds. Supabase documents a 150-second Free-plan wall-clock limit and a separate 2-second CPU limit. The design spends most runtime waiting for APIs, but actual deployed CPU and latency must still be observed. [Runtime limits](https://supabase.com/docs/guides/functions/limits).

## 1. Create the project

1. Sign in at [Supabase](https://supabase.com/dashboard) and create an organization/project on the Free plan.
2. Choose a region near you and save the database password in your password manager.
3. Wait until the database is ready. Copy the **project reference** from the dashboard URL or project settings. It is the identifier in `https://YOUR_PROJECT_REF.supabase.co`.
4. Keep the project URL handy. Do not put a service-role key in Discord or a frontend application.

The current Free plan lists 500 MB database storage and 500,000 Edge Function invocations, with project pausing after inactivity and no automatic database backups. Monitor actual usage; this is not a production uptime guarantee. [Pricing](https://supabase.com/pricing).

## 2. Prepare the checkout and CLI

From this repository directory, on Node.js 24:

```sh
npm ci
npm run check
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

The CLI login opens its account authorization flow. Linking may ask for the database password. Do not paste account tokens into this repository's documentation.

## 3. Create the database tables

```sh
npx supabase db push
```

This applies pending migrations, including `202609170001_scout.sql` and `202609240001_classifieds.sql`, to the linked project. The second migration is required for manual Marketplace evaluations and the updated retention schedule. The tables are named `scout_*`. RLS is enabled and ordinary anonymous/authenticated clients have no table or RPC access; only server code using the service role can access them. Discord user/server ownership is checked by the application, and confirmation is atomic in PostgreSQL.

If you prefer the SQL Editor, run each unapplied migration once in filename order. Choose one approach and keep migration history consistent; do not execute the same create-table migration twice. Existing deployments need only the new migration, rebuilt functions, updated Discord command registration and the revised schedule.

There was no production SQLite dataset deployed during the initial build. If you have since created local watches or imported records, back up that local database. Recreate/confirm watches in Discord against the cloud deployment and re-import your verified sales using `npm run import:cloud`. There is no automatic transfer of old alert history; do not delete the local database until you have checked your cloud data.

## 4. Configure secrets

```sh
cp .env.supabase.example .env.supabase
openssl rand -hex 32
```

Put the generated random value into `WORKER_SECRET` in `.env.supabase`. Keep it for the Vault step too. Fill in:

| Value                                  | Where to get it                                                |
| -------------------------------------- | -------------------------------------------------------------- |
| `DISCORD_TOKEN`                        | Discord application → Bot token                                |
| `DISCORD_APPLICATION_ID`               | Discord → General Information                                  |
| `DISCORD_PUBLIC_KEY`                   | Discord → General Information, Public Key                      |
| `DISCORD_GUILD_ID`                     | Discord server → Copy Server ID                                |
| `ALLOWED_USER_IDS`                     | Your Discord user ID; recommended for a private bot            |
| `GEMINI_API_KEY`                       | Google AI Studio                                               |
| `LLM_MODEL`                            | Keep `gemini-3.8-flash`, or a tested available model           |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | Your matching eBay developer keyset                            |
| `EBAY_POSTAL_CODE`                     | US delivery ZIP                                                |
| `EBAY_ENV`                             | Start with `sandbox`; production only after appropriate access |

Keep `CLOUD_MONITORING_ENABLED=false` and `DRY_RUN=true` for initial Discord setup. You can leave eBay/Gemini keys blank for `/alert test`; creating a natural-language watch requires Gemini.

Upload the file:

```sh
npx supabase secrets set --env-file .env.supabase
```

Supabase's hosted runtime supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Do not add those reserved names to the uploaded secrets file. The local import utility needs them separately in `.env` because it runs outside Supabase.

## 5. Build and deploy the functions

```sh
npm run build:cloud
npx supabase functions deploy discord-interactions --use-api
npx supabase functions deploy scout-worker --use-api
```

The build bundles the shared schemas, pricing, marketplace and LLM code into self-contained function files. Generated bundles are ignored by Git; regenerate them before deploying a changed checkout. `--use-api` avoids requiring local Docker for deployment. Do not deploy stale generated files.

`supabase/config.toml` disables Supabase JWT verification on both endpoints because they use their own authentication:

- `discord-interactions`: verifies Discord Ed25519 signature and timestamp, then enforces application, server and user checks.
- `scout-worker`: requires the random `WORKER_SECRET` as a Bearer token. An anonymous call must return 401.

Do not expose the worker secret in client code. Only Cron and the signed interactions handler use it.

## 6. Connect and test Discord

Follow the separate [Discord bot guide](discord-setup.md), including its Interactions Endpoint URL and command registration steps. `/alert test` should work while monitoring is disabled.

## 7. Add Cron and Vault

In the Supabase dashboard, enable **Cron (`pg_cron`)**, **HTTP requests (`pg_net`)**, and **Vault** if they are not enabled already. Dashboard labels can vary; these are database integrations/extensions.

Create these two Vault secrets using the dashboard:

| Vault name            | Value                                                       |
| --------------------- | ----------------------------------------------------------- |
| `scout_project_url`   | `https://YOUR_PROJECT_REF.supabase.co`                      |
| `scout_worker_secret` | Exactly the same value as the Edge Function `WORKER_SECRET` |

Then open the SQL Editor and run **`supabase/sql/schedule.sql`**. It creates:

- Four worker calls per minute to drain the queue. The database enqueues each active watch only when its interval is due (hourly by default); this does **not** poll eBay every minute for every watch.
- A daily cleanup for expired drafts, completed/dead jobs, stale budgets/cooldowns and old Cron run logs.

Four pulses per minute are approximately **172,800 function invocations per 30 days**, plus interactive wake-ups. One job per pulse gives a ceiling of 240 jobs/hour before failures or runtime overlap. Large watchlists, slow providers and quotas can create a backlog; start with two narrow watches and inspect it. [Supabase scheduling guide](https://supabase.com/docs/guides/functions/schedule-functions).

## 8. Import verified comparables

Add the project URL and **service_role** key to your ignored local `.env` (not `.env.supabase`). Retrieve the server-only service-role key from the project's API keys settings. Then:

```sh
npm run import:cloud -- /absolute/path/to/verified-sales.json
```

This performs a validated, transactional import into `scout_comparables`. See the [record format](comparables.md). Use the local SQLite import command only for local development.

## 9. Enable monitoring, then alerts

1. Confirm permitted marketplace access and populate the matching eBay keys.
2. Set `CLOUD_MONITORING_ENABLED=true` in `.env.supabase`; keep `DRY_RUN=true`.
3. Upload the secrets again. Supabase uses updated secrets for subsequent invocations; if an old isolate appears to retain values, redeploy the functions.
4. Create and confirm a narrow watch. Inspect worker logs, `scout_jobs` and `scout_processing` after the next Cron pulse.
5. When results look right, set `DRY_RUN=false` and upload secrets again.

Fee estimates are copied into each watch at confirmation. Review the preview JSON before saving. Changing environment fee defaults does not silently alter existing watches.

## Health, storage and recovery

Useful SQL Editor checks:

```sql
select kind, status, count(*) from public.scout_jobs group by kind, status;
select id, kind, error_kind, attempts from public.scout_jobs
where status = 'dead' order by created_at desc limit 20;
select id, status, message_id from public.scout_alerts
where status in ('sending','delivery_unknown');
select service, day, calls from public.scout_usage order by day desc limit 20;
```

Interaction tokens are stored temporarily in the service-only queue and cleared when jobs finish, fail terminally or expire. Do not share queue payloads in public troubleshooting screenshots. Queue and SQL RPC claims make jobs durable across function termination; provider failures retry at most three attempts. Discord commands with failed side effects are not blindly replayed. A crash mid-confirmation can leave a saved watch even if the response was lost: check `/watch list` before recreating it.

Alert reservations suppress duplicates across worker restarts. If a send is ambiguous, inspect the channel for the alert ID before manually reconciling `scout_alerts`. Retrying an uncertain send automatically could post twice.

The database grows with watches, source evidence, sales and alerts. The daily cleanup intentionally does not erase your alert history or comparable evidence. Monitor storage and export/retire old records before the Free quota is exhausted. Take your own database backups; Free does not include automatic backups. Review source-specific data-retention obligations too.

To stop polling without deleting anything, set `CLOUD_MONITORING_ENABLED=false`. Existing monitoring jobs will be drained without source calls; commands continue to work. Pausing the entire Supabase project stops both bot commands and monitoring.

## What is and is not verified

Local tests cover the SQL migration/RPC behavior, ownership, queue leases, budgets, signatures, pricing and alert serialization. A live deployment still needs your project/account setup and smoke tests above. Free-tier latency and cold starts can affect Discord's 3-second acknowledgement deadline; inspect real logs before relying on the bot. No external account was provisioned automatically.
