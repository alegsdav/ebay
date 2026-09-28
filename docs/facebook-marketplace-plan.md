# Facebook Marketplace source plan

Status: historical manual V1 plan; current scope correction below supersedes it.

Target implementer: Astra 6

Decision owner: project owner

## Scope correction (2026-09-24)

The user superseded the manual-first/sold-comparable design below. The required
workflow is natural-language request → saved location/delivery defaults → confirm
Gemini's suggested specifics → automatic Bright Data search → AI match → Discord
ping. No manual listing intake or sold-price evidence is required. See
[current implementation and next steps](NEXT-STEPS.md) for authoritative status.
The review below is historical, not the current onboarding workflow.

## Historical implementation review (2026-09-24)

The first release implements the recommended connector boundary and confirmed,
text-based manual evaluation in both the local Discord bot and Supabase worker.
It does not implement the complete managed-provider roadmap below.

Use an existing category watch to supply comparable matching, fee assumptions and
thresholds:

```text
/listing evaluate watch:<watch-id> source:facebook url:https://www.facebook.com/marketplace/item/123/ title:"Item title" price:50 location:"Santa Cruz, CA" condition:used notes:"Visible model and accessories" travel:10
```

The private preview contains the submitted facts and watch settings. Confirming
consumes the preview once, normalizes the redacted facts and returns the deal card
or an insufficient-evidence result. Confirmation expires after 15 minutes. Evidence
is retained for 30 days and is available to its owner through `/listing details
alert:<evidence-id>`. A failed confirmed evaluation requires a fresh submission.
Manual requests are explicit research requests and work while scheduled monitoring
or opportunity posting is disabled. No public-channel alert is sent.

Review decisions and compatibility changes:

- The deployed tables have a single listing ID and JSON data, not the proposed
  `source`/`source_item_id` columns. Existing eBay IDs remain intact. Manual IDs are
  `facebook_marketplace:manual:<item-id>`; they cannot collide with eBay IDs.
- `SourceListing` retains the existing validated listing field names. Optional
  provenance holds provider, access mode, external ID, retrieval time, schema
  version, evidence hash, city, delivery mode, travel estimate and source status.
  This avoids changing existing eBay evidence and alert output.
- Pickup in USD is the supported manual mode. Seller evidence and availability
  remain unknown. No seller profile, image or exact coordinates are collected.
  Phone/email/common street-address patterns are redacted before persistence and
  LLM normalization; do not submit personal information in free text.
- Manual results are conservatively capped at Tier 2. Insufficient exact sold
  comparables, unknown identity/condition or failed watch criteria stay Tier 3.
  Acquisition cost includes estimated travel, buyer fees, estimated tax and risk
  reserve; the reserve is not charged again against resale proceeds.
- Watch parsing recognizes source/location/delivery fields, but Marketplace watch
  creation and scheduling fail closed until a provider is approved. The existing
  six categories remain the supported categories; the laptop/chair examples below
  are future scope.
- `FACEBOOK_MONITORING_ENABLED` accepts only `false` in this release. No licensed
  provider is registered, even if an operator enables a source-config row.
- The new migration adds private source configuration, ingestion-run accounting,
  atomic provider request/cost budgets, submission/evaluation storage, retention
  cleanup and a Marketplace purge RPC. Provider credentials must never enter
  source-config JSON. These provider tables are groundwork, not a live adapter.

Still pending: optional screenshot extraction and confirmation of extracted facts;
reviewed vendor contract/live schema; provider fixtures, pagination, details,
quarantine, health checks and operational notifications; scheduled local watch
previews and location-capability validation; the one-week dry-run pilot. No
provider billing or live marketplace collection has been tested or enabled.

Deployment: apply `202609240001_classifieds.sql` after the original migration,
rebuild/redeploy the cloud functions or restart the local bot, register the updated
Discord commands, and reapply `supabase/sql/schedule.sql` for daily cleanup. Local
SQLite adds its tables automatically. Local expired records are removed on startup
and on new submissions. The service-only `scout_purge_classifieds('facebook_marketplace')`
RPC disables Marketplace configs and deletes Marketplace submissions, evaluations,
listings and ingestion evidence; it is intentionally destructive and is never
called automatically. Deletion cannot retract previously downloaded Discord files.

## Recommendation

Do not build or operate a first-party Facebook Marketplace scraper.

Meta's [Automated Data Collection Terms](https://www.facebook.com/legal/automated_data_collection_terms) require express written permission before automated collection from Meta products. Public visibility is not permission. Meta also states that automation used to collect Facebook data without permission violates its terms. There is no documented, generally available buyer-side Marketplace search API comparable to eBay Browse.

Build a provider-neutral `classifieds` source layer with two permitted ingestion modes:

1. `licensed_provider`: structured listing data supplied by a vendor under terms that allow this use.
2. `user_submitted`: a user manually submits listing facts or a screenshot for research.

Keep direct Facebook fetching, authenticated browser automation, session-cookie reuse, proxy rotation, CAPTCHA handling and anti-bot evasion out of the repository. A provider integration must be removable without changing normalization, scoring, storage or alerts.

## Provider decision

Use a short proof of concept before committing to a vendor.

| Option                                               | Fit                                                                               | Main concern                                                                                                 | Decision                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Bright Data managed Facebook Marketplace scraper/API | Structured search and listing fields; currently advertises a small free allowance | Confirm the exact product's license, permitted downstream use, billing unit, location coverage and freshness | Preferred provider to evaluate           |
| Apify Marketplace actors                             | Fast experiments and a small general free credit                                  | Actors may be community maintained; reliability and compliance obligations vary by actor                     | Fixtures/POC only after terms review     |
| Smaller Marketplace API vendors                      | Potentially simple REST integration                                               | Limited operating history, unclear provenance, retention and support                                         | Do not use without written answers       |
| Direct in-house scraper                              | Full apparent control                                                             | Conflicts with Meta's permission requirement; fragile login/CAPTCHA/UI surface                               | Rejected                                 |
| Manual submission                                    | Lowest acquisition risk and no provider cost                                      | Not continuous monitoring                                                                                    | Build first as fallback and test harness |

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

The Facebook layer finds local asking-price opportunities and sends research alerts. It does not message sellers, make offers, reserve items, authenticate as a Facebook user, or automate purchases.

Natural-language examples:

```text
/watch create query: Facebook Marketplace gaming laptops within 25 miles of Santa Cruz under $500
/watch create query: local Herman Miller Aeron chairs under $350, size B preferred
```

The watch preview must show:

- Source: Facebook Marketplace via the configured provider, or manual submission.
- Location label and radius. Do not expose exact home coordinates in Discord.
- Pickup, shipping or either.
- Maximum asking price and optional estimated travel cost.
- Required/excluded terms and category-specific attributes.
- Comparable policy and confidence cap.
- Provider cost estimate and polling interval.
- A notice that Marketplace prices are asking prices, not completed-sale evidence.

## Architecture

Add an interface in front of the existing eBay connector rather than adding Facebook branches throughout the pipeline.

```ts
type AccessMode = "authorized_api" | "licensed_provider" | "user_submitted";

interface ListingSourceConnector {
  readonly source: string;
  readonly accessMode: AccessMode;
  capabilities(): SourceCapabilities;
  validateWatch(watch: NormalizedWatch): ValidationResult;
  search(input: SourceSearchInput, signal: AbortSignal): Promise<SearchPage>;
  details?(externalId: string, signal: AbortSignal): Promise<SourceListing>;
  healthcheck(signal: AbortSignal): Promise<SourceHealth>;
}
```

Target flow:

```text
natural-language watch
  -> deterministic source/category/location validation
  -> source-specific query plan
  -> provider adapter
  -> canonical SourceListing
  -> cheap filters and deduplication
  -> LLM normalization for plausible candidates only
  -> category-aware independent comparables
  -> deterministic deal score
  -> Discord alert or silent storage
```

The core pipeline must consume only `SourceListing`; provider-specific payloads stay inside the adapter and evidence store.

## Canonical listing contract

```ts
interface SourceListing {
  source: "ebay" | "facebook_marketplace" | "manual";
  provider: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  description?: string;
  askingPrice: { amount: number; currency: string };
  delivery: {
    modes: Array<"pickup" | "shipping">;
    shippingCost?: number;
    locationLabel?: string;
    distanceMiles?: number;
  };
  condition?: string;
  imageUrls: string[];
  seller: {
    displayName?: string;
    rating?: number;
    ratingCount?: number;
  };
  sourceCreatedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: "active" | "pending" | "sold" | "removed" | "unknown";
  rawEvidenceRef: string;
}
```

Rules:

- Treat seller fields and approximate location as personal data. Collect the minimum needed for review.
- Do not download or permanently mirror images in V1. Store source URLs only when provider terms permit it.
- Preserve provider name, retrieval time, provider request ID, payload schema version and a payload hash.
- Never turn missing values into inferred facts. Use `unknown` and lower confidence.
- Use the provider's stable ID when available. Fall back to canonical URL hash plus title/price/location similarity.

## Database changes

Create a new migration rather than editing the deployed initial migration.

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

- Keep `scout_listings.source` and `source_item_id` as the cross-source identity.
- Add `provider`, `access_mode`, `location_label`, `distance_miles`, `delivery_modes`, `source_status`, `evidence_hash` and `provider_retrieved_at` if the existing JSON evidence is insufficient for indexed queries.
- Add source/provider/cost fields to the daily usage budget.
- Keep comparable sales independent from the discovery source. A Facebook listing may use verified eBay sold records or manually imported sales.

Avoid storing precise coordinates, seller profile URLs or seller photos unless a reviewed use case requires them.

## Watch parsing changes

Extend the structured watch schema with:

```json
{
  "sources": ["facebook_marketplace"],
  "location": {
    "label": "Santa Cruz, CA",
    "postal_code": "95060",
    "radius_miles": 25
  },
  "delivery_modes": ["pickup"],
  "max_asking_price": 500,
  "max_estimated_all_in_cost": 540
}
```

The LLM may extract a location phrase and radius, but deterministic code must validate supported countries, radius bounds, currency and provider capabilities. Ask for clarification when a local-marketplace watch has no location. Store a city/postal area rather than a user's street address.

## Pricing and confidence

Facebook Marketplace supplies asking prices, not reliable completed-sale prices. Never use active Marketplace listings as sold comparables.

For local pickup:

```text
estimated acquisition cost =
  asking price
  + estimated travel cost
  + known buyer fees
  + risk reserve
```

Do not assume a negotiated discount. If the user wants a target-offer view, show it separately from the current asking-price calculation.

Use independent sold evidence for resale value. Category rules still require exact model/revision/condition matches. Apply these Marketplace-specific confidence limits:

- Unknown model or condition: Tier 3 only.
- No independent sold comparables: Tier 3 only.
- Fewer than the watch's minimum comparables: at most Tier 2.
- Missing serial/model/accessory evidence: at most Tier 2.
- Exact product plus adequate sold evidence may reach Tier 1, but still requires in-person verification.

Add Marketplace risk signals such as deposit requests, off-platform payment language, stock-photo-only listings, implausible price, conflicting location, shipping-only local listings and newly created/unknown seller evidence. These signals lower confidence; the bot must not accuse a seller of fraud.

## Manual-submission V1

Build this before the managed provider connector. It validates the normalization and scoring flow without scheduled collection.

Suggested Discord command:

```text
/listing evaluate source:facebook url:<url> title:<title> price:<amount> location:<city> notes:<optional>
```

Allow an optional screenshot attachment. The LLM may extract visible listing facts, but the user must confirm the structured preview before scoring. Store the submitted facts and extraction evidence; do not have the server fetch the Facebook URL.

Return the same deal card as scheduled sources, labeled `User-submitted Marketplace listing`. This path also becomes the test fixture generator for the provider adapter.

## Managed-provider connector

Implement only after provider review.

Configuration:

- `FACEBOOK_PROVIDER=brightdata` or another approved adapter.
- Provider API key in Supabase secrets.
- Per-provider daily request and cost-unit limits.
- Global feature flag `FACEBOOK_MONITORING_ENABLED=false` by default.
- Source kill switch that leaves Discord commands and eBay processing available.

Operational behavior:

- Start with one location, one narrow category and a six-hour interval.
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

- Store only fields needed for matching, scoring and audit.
- Redact phone numbers, email addresses and street addresses before persistence or LLM calls.
- Do not send seller identifiers to the LLM unless needed for a defined classification task.
- Keep raw provider payloads short lived; start with 30 days and retain normalized evidence longer.
- Delete user-submitted screenshots after extraction unless the user explicitly saves them as alert evidence.
- Add a source-wide purge procedure before enabling the connector.
- Log the LLM model/prompt version without logging provider or Discord credentials.

## Build sequence for Astra 6

1. Read the current Supabase migration, cloud queue, eBay connector, watch schema and alert formatter. Preserve existing behavior.
2. Add the source interface and adapt eBay to it without changing eBay output.
3. Add source capabilities and access-mode enforcement. Reject unregistered direct-scrape connectors at configuration validation.
4. Add a new database migration and store methods for source configs and ingestion runs.
5. Extend watch parsing, preview and persistence for source/location/delivery fields.
6. Implement `/listing evaluate` with confirmed manual data and optional screenshot extraction.
7. Add recorded provider fixtures and contract tests for pagination, missing fields, price changes, removal and malformed payloads.
8. Implement one approved managed-provider adapter behind a disabled feature flag.
9. Add provider budgets, health checks, metrics, retention cleanup and kill switches.
10. Add source labels, location, pickup costs, provenance and Marketplace warnings to Discord alerts.
11. Run a dry-run pilot for at least one week before enabling alerts.

Do not add browser automation, Facebook login credentials, cookies, proxy rotation or CAPTCHA-solving dependencies during any step.

## Acceptance criteria

- Existing eBay tests and behavior remain green.
- A connector cannot run unless its access mode is registered and enabled.
- Manual Marketplace evaluation works without any server-side Facebook request.
- Provider payloads validate into the canonical listing schema.
- Provider credentials exist only in Supabase secrets.
- Location is required for local searches and precise home coordinates are not exposed.
- Asking prices never enter the sold-comparable table.
- All arithmetic is deterministic and tested.
- LLM output is schema validated and cannot invent prices or comparables.
- Duplicate provider records do not create duplicate alerts.
- Budgets and kill switches stop provider calls deterministically.
- Alerts show source/provider, asking-price status, independent comparable count, confidence limits and verification warnings.
- Monitoring defaults off until provider terms, live schema and costs have been reviewed.

## Rollout recommendation

The best next build is the connector abstraction plus manual Marketplace evaluation. It gives immediate utility and tests the cross-source scoring model without depending on unauthorized collection. After that, run a small managed-provider proof of concept using recorded fixtures and one narrow live watch. Keep the provider behind a feature flag until data rights, cost behavior, freshness and reliability are documented.
