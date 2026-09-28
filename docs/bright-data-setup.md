# Bright Data account and API setup

Bright Data supplies the Facebook Marketplace leg of keyword watches. The connector is
implemented in `src/connectors/brightdata.ts`; this guide covers the account side.

## What the bot needs

Only your **API key**. The scraper to run is identified by a public dataset ID that
the bot already knows (`gd_lvt9iwuh6fbcwmx1a`, "Facebook Marketplace – collect
listings by keyword"). Nothing needs configuring in the Bright Data dashboard.

```text
BRIGHT_DATA_API_KEY=secret account-level bearer token
FACEBOOK_MONITORING_ENABLED=true
```

The API key authenticates and bills your account. The dataset ID picks which of
Bright Data's many pre-built scrapers runs. Optional tuning values (record counts,
monthly cap, date filter) are listed in `.env.supabase.example`.

## Cost

Pay-as-you-go is $1.50 per 1,000 records; Bright Data advertises 5,000 free records
per month. Every returned record is billed, including listings the bot has already
seen. At the defaults (first search 10 records, then 2 per hourly poll), one watch
uses about 1,450 records per month; 5 watches at hourly polls would need about 7,200,
so the default monthly cap of 4,500 stops polling around day 19. Set a monthly spend
limit in the Bright Data dashboard as a backstop, and do not enable auto-recharge.

## 1. Create and verify the account

1. Open the [Facebook Marketplace Scraper API](https://brightdata.com/products/web-scraper/facebook/marketplace) page and choose **Start free**.
2. Create the Bright Data account and verify its email address.
3. Complete any compliance/use-case questions accurately. Describe the project as private price research and deal alerts using public Marketplace listings. It does not contact sellers, enrich personal profiles or automate transactions.
4. Stay on the Free tier. A new account currently advertises 5,000 free records per month with no credit card required.
5. Do not enable auto-recharge and do not add a payment method for the first proof of concept. Without a balance, requests should stop when the monthly free allowance is exhausted.

Bright Data may review the use case before enabling a scraper. Approval by Bright Data does not replace the project's own review of its license, data rights and retention obligations.

## 2. Create the API token

1. Open [Account settings → Users and API keys](https://brightdata.com/cp/setting/users).
2. Use the existing account API key or create a dedicated key named `auction-scout-dev`.
3. If the dashboard offers expiration or permission controls, choose the shortest practical expiration and only the permissions required for Web Scraper APIs and usage/balance reads.
4. Copy the token once into a password manager.

This must be an account API token. A zone password or browser-proxy credential will not authenticate the dataset endpoints.

Do not paste the token into Discord, GitHub, documentation, an issue or a chat message.

## 3. Put the key in local configuration

Add this line to the Git-ignored `.env.supabase` file:

```dotenv
BRIGHT_DATA_API_KEY=replace_with_the_real_token
```

The token does not belong in `.env.supabase.example`; only an empty placeholder belongs there.

## 4. Validate without spending Marketplace records

The token can be checked against Bright Data's account API before running a scraper:

```sh
curl -sS \
  -H "Authorization: Bearer $BRIGHT_DATA_API_KEY" \
  https://api.brightdata.com/zone/get_active_zones
```

A successful authenticated response confirms the account-level token. It does not prove that the selected Marketplace scraper is enabled.

Do not print the token during debugging. A `401` usually means the wrong credential type, an expired/revoked token, whitespace copied with the token or a missing `Bearer` prefix.

## 5. Upload the key to Supabase

Upload only the key (avoid overwriting other secrets with blank entries):

```sh
npx supabase secrets set BRIGHT_DATA_API_KEY=...
npx supabase secrets set FACEBOOK_MONITORING_ENABLED=true
```

Supabase Edge Functions receive the key at runtime. Never store it in a database table, Discord command, watch configuration or provider payload.

## Cost guardrails

- Start with one watch and one location.
- Request the fewest records and pages possible.
- Count delivered records, not just HTTP calls; Bright Data bills the Marketplace scraper per successful record.
- Keep `BRIGHT_DATA_MAX_RECORDS_PER_MONTH` below the monthly free allowance.
- Do not enable auto-recharge during the proof of concept.
- Stop the connector when the provider reports insufficient balance or quota exhaustion.
- Recheck the Bright Data pricing page before enabling production monitoring; free-tier terms can change.
