# Facebook Marketplace source plan

Status: current as of the keyword-watch rework (2026-09-28).

Decision owner: project owner

## Current implementation

Facebook Marketplace is one of two sources a keyword watch searches; eBay is the
other. Both are on by default and a watch can opt out of either (`sources:` on
`/watch create` and `/watch update`). Marketplace listings alert on a keyword and
attribute match alone: there is no sold-price, profit or discount gate, no category
list and no manual listing submission. `/listing evaluate` was removed.

- `src/connectors/brightdata.ts` calls Bright Data's Facebook Marketplace scraper
  (dataset `gd_lvt9iwuh6fbcwmx1a`, `type=discover_new&discover_by=keyword`). Input:
  `keyword`, `city` ("City, ST"), `radius` (miles) and `date_listed`. Searches take
  1–6 minutes, so a `scan` job triggers a snapshot and a later `snapshot` job polls
  `/progress` and downloads it. Triggers are never retried automatically.
- The first search for a watch's keywords and city asks for
  `BRIGHT_DATA_INITIAL_RECORDS` (10) with no date filter; later polls (every 90 minutes by default) ask for
  `BRIGHT_DATA_POLL_RECORDS` (2) with `date_listed` = `BRIGHT_DATA_RECENT_FILTER`.
  Each run is recorded in `scout_ingestion_runs` with a query key.
- Bright Data bills every returned record, including listings the bot already saw.
  Seen listings are skipped before extraction and alerts but still count. Records are
  reserved against `BRIGHT_DATA_MAX_RECORDS_PER_MONTH` before each trigger
  (`scout_take_monthly_budget`) and unused ones refunded after download.
- `mapBrightDataRecord()`/`marketplaceListing()` build canonical listings: canonical
  URL and ID, redacted text, condition mapping, `listing_date` as `listedAt`, USD only.
  Seller `profile_id`, images and videos are not kept.
- Three gates must all allow a search: `FACEBOOK_MONITORING_ENABLED` plus
  `BRIGHT_DATA_API_KEY`, the registered `facebook_marketplace:brightdata:licensed_provider`
  triple, and the watch's own `sources`. Disabled legs are skipped per watch.
- ZIP-only `/defaults` are converted to "City, ST" by Gemini at save time.
- Watches that include Marketplace: at most 5 active (testing cap), hourly minimum.

Observed in live tests (2026-09-28): a city without a state ("Portland") matched a
different region; "Portland, OR" returned Portland-area listings, but "Campbell, CA"
was not recognized (results fell back to Virginia) while "Campbell, California"
worked, so the connector sends full state names (`providerCity()`). An unrecognized
city is detected when no listing in a batch is in the watch's state. `radius` is
applied loosely (metro-area results).
Identical searches returned different listings each time, not sorted by date, and
"Last 24 hours" still returned older listings. Small polls may therefore miss some
new listings; the discover-by-URL mode (which could sort newest first) was rejected
for this account.

## Recommendation

Do not build or operate a first-party Facebook Marketplace scraper.

Meta's [Automated Data Collection Terms](https://www.facebook.com/legal/automated_data_collection_terms) require express written permission before automated collection from Meta products. Public visibility is not permission. Meta also states that automation used to collect Facebook data without permission violates its terms. There is no documented, generally available buyer-side Marketplace search API comparable to eBay Browse.

Ingest Marketplace data only through a `licensed_provider`: structured listing data supplied by a vendor under terms that allow this use.

Keep direct Facebook fetching, authenticated browser automation, session-cookie reuse, proxy rotation, CAPTCHA handling and anti-bot evasion out of the repository. A provider integration must be removable without changing extraction, matching, storage or alerts.

## Provider decision

Use a short proof of concept before committing to a vendor.

| Option                                               | Fit                                                                               | Main concern                                                                                                 | Decision                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Bright Data managed Facebook Marketplace scraper/API | Structured search and listing fields; currently advertises a small free allowance | Confirm the exact product's license, permitted downstream use, billing unit, location coverage and freshness | Selected; implemented                |
| Apify Marketplace actors                             | Fast experiments and a small general free credit                                  | Actors may be community maintained; reliability and compliance obligations vary by actor                     | Fixtures/POC only after terms review |
| Smaller Marketplace API vendors                      | Potentially simple REST integration                                               | Limited operating history, unclear provenance, retention and support                                         | Do not use without written answers   |
| Direct in-house scraper                              | Full apparent control                                                             | Conflicts with Meta's permission requirement; fragile login/CAPTCHA/UI surface                               | Rejected                             |

Bright Data currently advertises Facebook Marketplace fields and a free allowance, but the project must verify the account's actual billing screen before enabling scheduled calls. A free-credit statement does not guarantee that hourly searches and detail fetches fit within the allowance.

Before approving any provider, record answers to these questions:

- Does the contract permit storing, analyzing and sending listing excerpts to a private Discord server?
- Is Marketplace explicitly covered, rather than generic Facebook pages?
- Does the provider warrant that it is authorized to supply the data?
- Which fields are personal data, and what retention/deletion rules apply?
- Are images licensed for storage, or may the bot retain only their source URLs?
- What is one search, page, result and detail request billed as?
- What locations, radii, categories and pagination are supported?
- How are removed/sold listings represented?
- Is there a stable listing ID and canonical URL?
- What rate, freshness and uptime commitments exist?

## Product scope

The Marketplace leg finds local listings matching a keyword watch and sends alerts. It does not message sellers, make offers, reserve items, authenticate as a Facebook user, or automate purchases.

Natural-language examples:

```text
/watch create query: gaming laptops within 25 miles of Santa Cruz under $500
/watch create query: Herman Miller Aeron chair size B under $350 sources:Facebook Marketplace only
```

The watch preview shows the keywords, sources, price range, conditions, excluded terms and attribute criteria; for Marketplace, the location label, radius and pickup/shipping (never exact coordinates); the polling interval and alert channel; and a notice while Marketplace searching is turned off.

## Architecture

Both sources implement the same connector interface (`src/connectors/source.ts`):

```ts
type AccessMode = "authorized_api" | "licensed_provider";

interface ListingSourceConnector {
  readonly source: "ebay" | "facebook_marketplace";
  readonly provider: string;
  readonly accessMode: AccessMode;
  capabilities(): SourceCapabilities;
  validateWatch(watch: WatchConfig): void;
  search(watch: WatchConfig): AsyncIterable<SourceListing>;
  detail?(listing: SourceListing): Promise<SourceListing>;
}
```

Target flow:

```text
keyword watch
  -> per enabled source: provider adapter keyword search
  -> canonical SourceListing (redacted, with provenance)
  -> cheap filters and deduplication
  -> LLM extraction for plausible candidates only (relevance + requested attributes)
  -> attribute constraint check
  -> single Discord alert or silent storage
```

The core pipeline consumes only `SourceListing`; provider-specific payloads stay inside the adapter and evidence store.

## Canonical listing contract

Both sources produce the `Listing` schema in `src/config/schema.ts`, which keeps the original eBay field names (`id`, `url`, `title`, `description`, `specifics`, `price`, `shipping`, `condition`, `seller*`, `auction`, `endTime`). Marketplace records must carry `provenance`: provider, access mode, external ID, retrieval time, schema version, evidence hash, location label, delivery modes and source status (`active`, `pending`, `sold`, `removed` or `unknown`). Seller fields are `unknown`/`null` for Marketplace. Build records with `marketplaceListing()` so identity, redaction and hashing stay consistent.

Rules:

- Treat seller fields and approximate location as personal data. Collect the minimum needed for review.
- Do not download or permanently mirror images in V1. Store source URLs only when provider terms permit it.
- Preserve provider name, retrieval time, provider request ID, payload schema version and a payload hash.
- Never turn missing values into inferred facts. Use `unknown` and lower confidence.
- Use the provider's stable ID when available. Fall back to canonical URL hash plus title/price/location similarity.

## Database

These provider tables exist (`202609240001_classifieds.sql`). Add new migrations rather than editing deployed ones.

### `scout_source_configs`

- `id`
- `source`
- `provider`
- `access_mode`
- `enabled`
- `config` JSONB containing non-secret provider options
- `poll_interval_minutes`
- `daily_request_limit`
- `terms_reviewed_at`
- `terms_reference`
- `created_at`, `updated_at`

Provider credentials remain Supabase secrets and never enter this table.

### `scout_ingestion_runs`

- `id`
- `source_config_id`
- `watch_id`
- `provider_request_id`
- `status`
- `pages_requested`
- `records_received`
- `records_accepted`
- `cost_units`
- `error_kind`
- `started_at`, `finished_at`

### Existing tables

- Listing identity is the namespaced `scout_listings.id` plus JSON data; no separate `source`/`source_item_id` columns exist.
- Add indexed columns such as `provider`, `location_label` or `source_status` only if the JSON evidence proves insufficient for queries.
- Provider accounting can use `scout_source_usage`/`scout_take_source_budget` or the simpler `scout_usage` per-service counter.

Avoid storing precise coordinates, seller profile URLs or seller photos unless a reviewed use case requires them.

## Watch parsing

The structured watch includes Marketplace fields alongside the keyword filters:

```json
{
  "sources": ["ebay", "facebook_marketplace"],
  "location": {
    "label": "Santa Cruz, CA",
    "postalCode": "95060",
    "radiusMiles": 25
  },
  "deliveryModes": ["pickup"],
  "minPrice": null,
  "maxPrice": 500
}
```

The LLM may extract a location phrase and radius, but deterministic code validates radius bounds, currency and provider capabilities. Saved `/defaults` fill in a missing area. A watch that includes Marketplace without an area is rejected with a prompt to run `/defaults` or choose eBay only; an eBay-only watch needs no location. Store a city/postal area rather than a user's street address.

## Matching and warnings

A Marketplace listing alerts when it passes the same checks as an eBay listing: excluded keywords, price range, condition (an unknown provider condition defers to the extracted one), relevance to the search, and the watch's attribute constraints. Asking prices are shown as-is; no negotiated discount or resale value is estimated.

Marketplace risk phrases (deposit, wire transfer, gift card, crypto, stock photo, shipping only) add verification warnings to the alert, along with a reminder to verify item, condition and seller in person. They never block a match; the bot must not accuse a seller of fraud.

## Managed-provider connector

Implement only after provider review.

Configuration:

- `FACEBOOK_PROVIDER=brightdata` or another approved adapter.
- Provider API key in Supabase secrets.
- Per-provider daily request and cost-unit limits.
- Global feature flag `FACEBOOK_MONITORING_ENABLED=false` by default.
- Source kill switch that leaves Discord commands and eBay processing available (implemented: the worker skips the Marketplace leg per watch).

Operational behavior:

- Start with one location and one narrow keyword watch.
- Request the smallest page/result set supported.
- Stop paging when all records are older than the last successful watermark.
- Refresh details only for new listings or material price/status changes.
- Retry network and 5xx failures with bounded exponential backoff.
- Do not retry authentication, permission, schema or terms-related failures automatically.
- Quarantine payloads that fail schema validation.
- Alert the administrator when the provider schema changes or the daily budget is exhausted.

## Cross-source deduplication

Do not merge eBay and Marketplace listings merely because titles are similar; they are usually distinct physical items. Deduplicate only within a source/provider identity unless there is strong evidence that the same seller cross-posted the same item.

For suspected cross-posts, retain both source records and create a soft relationship containing match reasons. Never discard one source record automatically.

## Privacy and retention

- Store only fields needed for matching and audit.
- Redact phone numbers, email addresses and street addresses before persistence or LLM calls.
- Do not send seller identifiers to the LLM unless needed for a defined classification task.
- Keep raw provider payloads short lived; start with 30 days and retain normalized evidence longer.
- Use the source-wide purge procedure, `scout_purge_classifieds('facebook_marketplace')`, to disable the source and delete its listings, queued listing jobs and ingestion evidence. It is destructive and never called automatically.
- Log the LLM model/prompt version without logging provider or Discord credentials.

## Remaining work

1. Run one narrow watch in dry-run, then with alerts, and compare its hits with Facebook.
2. If small polls miss too many new listings, ask Bright Data to enable discover-by-URL
   (a Marketplace search URL sorted by newest) or raise the per-poll record count.
3. Add health checks, quarantine of invalid payloads and operator notifications.

Do not add browser automation, Facebook login credentials, cookies, proxy rotation or CAPTCHA-solving dependencies during any step.

## Acceptance criteria

- eBay tests and behavior remain green, and eBay legs keep running while Marketplace is disabled.
- A connector cannot run unless its access mode is registered and enabled.
- Provider payloads validate into the canonical listing schema with redacted text.
- Provider credentials exist only in Supabase secrets.
- Location is required for Marketplace searches and precise home coordinates are not exposed.
- LLM output is schema validated and cannot invent listing facts.
- Duplicate provider records do not create duplicate alerts.
- Budgets and kill switches stop provider calls deterministically.
- Alerts show source, asking price, pickup area and verification warnings.
- Monitoring defaults off until provider terms, live schema and costs have been reviewed.

## Rollout recommendation

Keep the provider behind `FACEBOOK_MONITORING_ENABLED=false` until the real adapter is tested against recorded fixtures and one narrow live watch, and until data rights, cost behavior, freshness and reliability are documented.
