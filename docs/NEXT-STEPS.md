# Your next steps — automatic Marketplace matching

## Current blocker — September 27, 2026

The Bright Data account and API key now exist; the key is saved privately in
`.env.supabase`. The user reports a $0 balance, no free credits, and account status
“suspended by system.” Activation offers adding a card and funds. Do not fund the
account or run collection under the current $0 budget. Ask Bright Data support to
explain the suspension and confirm free-tier eligibility. Monitoring remains off.
The account-creation steps below are reference instructions, not work to repeat.

Updated September 24, 2026. This replaces the earlier manual-listing plan.
The goal is automatic Facebook discovery → AI checks your criteria → Discord ping.
You do **not** need `/listing evaluate`, sold-price records, profit estimates, or
price trends. Those older commands remain available but are not part of onboarding.

## What this change implements

- `/defaults city:<US city and state> radius:<miles> delivery:<pickup|shipping|either>`.
  Use `zipcode:<five digits>` instead of city. Omit all options to view settings.
  Settings are private to your Discord user in this server, persist in Supabase,
  and apply to new watch previews. Changing them does not silently change existing watches.
- New natural-language watches default to Facebook Marketplace. Explicit query
  location/delivery settings override saved defaults. Existing eBay watches are preserved.
- Gemini proposes measurable interpretations of vague preferences. For example,
  “lightweight” may produce “weight_grams ≤ 50 g.” You confirm the proposal or
  click **Edit query**, change the prefilled numeric value, and review again.
  No watch is saved before confirmation. Recommendations are preferences, not
  AI-invented facts about a listing. Missing actual weight will not prove a match.
- Marketplace previews are match-only, with no resale/sold-comparable requirement.
- Database-enforced maximum of 10 active Marketplace watches across the deployment;
  minimum interval 1,440 minutes (daily). Pausing frees a slot. These are scheduling
  guardrails, not a completed provider billing limiter.

## What is NOT running yet

Bright Data is not connected. No automatic Facebook searches, automatic AI
listing-match checks, or real match pings are running. Saving a watch prepares its
criteria; it does not mean a search has started. `/stats` and confirmation messages
say this explicitly. Monitoring stays OFF and dry-run stays ON.

Remaining implementation: verified Bright Data keyword-search adapter, asynchronous
result retrieval, provider-side result limits, durable monthly record reservations,
match-only listing evaluation, and real owner-ping delivery tests. Do not enable
monitoring merely because an API key has been saved.

## Your next manual actions

After the preferences release is deployed (see deployment-status.md):

1. In your existing Discord server, run `/defaults zipcode:YOUR_ZIP radius:25 delivery:pickup`.
   Substitute your ZIP; `city:Portland, OR` is an example alternative.
2. Run `/watch create query:lightweight gaming mouse under 20 bucks`.
3. Check the proposed weight threshold. Confirm it, or use **Edit query** to change
   the number. `/watch list` shows the saved watch. This tests preferences and Gemini,
   not live discovery. Existing eBay watches are not automatically converted.
4. Create a **free Bright Data account**, then find **Web Scraper API → Facebook
   Marketplace → collect listings by keyword**. No additional Supabase project,
   Discord bot, proxy subscription, or paid Bright Data plan is needed.
5. Verify your account actually shows the free allowance. Do not add paid funds,
   a payment card, or auto-recharge for this $0 budget. Generate an API token and
   store it privately in the ignored `.env.supabase` as `BRIGHT_DATA_API_KEY=...`;
   do not paste the token into chat or commit it.
6. Copy the dashboard-generated **keyword discovery API request**, with its bearer
   token removed, and a small sample response if available. The public example for
   individual listing URLs is a different workflow. We need the search input shape,
   city/radius/delivery support, dataset ID and enforceable maximum-results setting
   before enabling real collection. Do not launch an uncapped collection.

Tell the assistant when the key is stored and share the sanitized request example.
The next engineering step is to complete and test automatic discovery against that
actual provider contract, not send you back to find listings manually.

## Free-tier sizing

[Bright Data's Marketplace page](https://brightdata.com/products/web-scraper/facebook/marketplace)
advertises 5,000 free records per month. This is not 5,000 searches, and free credits
may be shared with other Bright Data products. Confirm eligibility in your account.

Proposed steady-state allocation: **10 watches × 15 returned records × 31 days =
4,650 records/month**. The other 350 are contingency, not permission to exceed
the allowance. Repeated listings may still be billable records. A strict monthly
reservation counter must stop requests before the allowance is exhausted, including
test traffic, retries and other consumption. This is a daily scan, not instant
coverage of every listing; search coverage and delivery filters still need verification.
