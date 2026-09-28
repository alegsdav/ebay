# Bright Data account and API setup

This guide prepares Bright Data for the Facebook Marketplace leg of keyword watches. The connector in `src/connectors/brightdata.ts` is a stub until the keyword-search contract below is captured. Nothing here enables Marketplace monitoring by itself.

Current status (September 28, 2026): the account now has $5 of usable credit.
Earlier it was suspended with no free credits; do not add more funds or enable
auto-recharge. The credential name is `BRIGHT_DATA_API_KEY` and the dataset ID is
`BRIGHT_DATA_DATASET_ID`. The stub connector does not read either yet.

## Values the application will need

```text
BRIGHT_DATA_API_KEY=secret account-level bearer token
BRIGHT_DATA_DATASET_ID=non-secret keyword-discovery scraper identifier
BRIGHT_DATA_MAX_CALLS_PER_DAY=10
FACEBOOK_MONITORING_ENABLED=false
```

The API token is a credential. The dataset ID selects a particular Bright Data scraper and is safe to include in ordinary configuration.

Do not use a proxy-zone password, Facebook password, Facebook cookie or Facebook access token. Bright Data's Web Scraper API authenticates with the account-level API token in an `Authorization: Bearer ...` header.

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

## 3. Select the correct Marketplace scraper

Bright Data currently lists multiple Marketplace products:

- **Facebook Marketplace**: fetches details for known listing URLs.
- **Collect Facebook Marketplace listings by keyword**: discovers listings for a search term.
- **Discover by URL**: discovers records from a supplied Marketplace search/category URL.

Keyword watches need the keyword discovery scraper for scheduled searches, and the single-listing scraper only if a detail refresh proves necessary.

For the proof of concept:

1. Open the Facebook Marketplace scraper library.
2. Select **Collect Facebook Marketplace listings by keyword**.
3. Open its API/code example.
4. Copy the exact `dataset_id` shown for that scraper. Do not assume the sample ID for the single-listing URL scraper is also the keyword scraper.
5. Record the displayed input schema. The keyword scraper may require a keyword plus location or a Marketplace search URL, depending on the current Bright Data version.
6. Set the output limit to the smallest permitted value for the first run.

Save the dataset ID separately from the API token.

## 4. Put the values in local configuration

Add these lines to the Git-ignored `.env.supabase` file:

```dotenv
BRIGHT_DATA_API_KEY=replace_with_the_real_token
BRIGHT_DATA_DATASET_ID=replace_with_the_keyword_scraper_dataset_id
FACEBOOK_MONITORING_ENABLED=false
```

Keep monitoring disabled. The application does not use these values until the Marketplace connector's real `search()` is implemented.

The token does not belong in `.env.supabase.example`; only an empty placeholder belongs in the example file. The real `.env.supabase` is ignored by Git.

## 5. Validate without spending Marketplace records

The token can be checked against Bright Data's account API before running a scraper:

```sh
curl -sS \
  -H "Authorization: Bearer $BRIGHT_DATA_API_KEY" \
  https://api.brightdata.com/zone/get_active_zones
```

A successful authenticated response confirms the account-level token. It does not prove that the selected Marketplace scraper is enabled.

Do not print the token during debugging. A `401` usually means the wrong credential type, an expired/revoked token, whitespace copied with the token or a missing `Bearer` prefix.

## 6. Run one controlled Marketplace test

Use Bright Data's dashboard test runner first. Supply one narrow keyword and one supported location, request the smallest result count and inspect:

- The exact request input.
- Dataset ID.
- Whether the response is immediate or returns a snapshot ID.
- Listing ID and canonical URL stability.
- Location and distance fields.
- Price types and currency.
- Condition and category fields.
- Created, updated and retrieval timestamps.
- Removed/sold status behavior.
- Number of free records consumed.

Download the first successful JSON response as a development fixture after removing seller names, profile URLs, precise locations and other unnecessary personal fields.

Do not schedule the scraper from Bright Data's dashboard. Supabase will own scheduling and budgets after the connector is implemented.

## 7. Upload the token to Supabase later

After the connector exists and the local test passes, upload the Git-ignored environment file:

```sh
npx supabase secrets set --env-file .env.supabase
```

Before uploading, make sure `.env.supabase` contains no blank entries that could overwrite a working secret. Keep `FACEBOOK_MONITORING_ENABLED=false` until dry-run processing has been inspected.

Supabase Edge Functions receive the token at runtime. Never store it in a database table, Discord command, watch configuration or provider payload.

## Cost guardrails

- Start with one watch and one location; Marketplace watches run at most daily.
- Request the fewest records and pages possible.
- Count delivered records, not just HTTP calls; Bright Data bills the Marketplace scraper per successful record.
- Set an application daily-record limit below the monthly free allowance.
- Do not enable auto-recharge during the proof of concept.
- Stop the connector when the provider reports insufficient balance or quota exhaustion.
- Recheck the Bright Data pricing page before enabling production monitoring; free-tier terms can change.

## What to send back for integration

Do not send the API token. Provide only:

- Confirmation that `BRIGHT_DATA_API_KEY` is saved in `.env.supabase`.
- The keyword-discovery `dataset_id`.
- The input-field names shown by Bright Data.
- A redacted sample JSON response.
- The free-record balance before and after the test.
