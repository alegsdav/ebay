# Design decisions and acceptance coverage

The hosted architecture uses Supabase PostgreSQL, signed Discord HTTP interactions, leased queue jobs, Edge Functions and Cron. It is the only deployment target. See [the deployment guide](supabase-setup.md).

The bot is a cross-source keyword watcher: one watch searches eBay and Facebook Marketplace by default and posts each new matching listing once to its channel. There is no fixed category list, sold-price comparison, profit or discount math, or strong/possible tiering. A user may opt a watch out of either source.

```text
watch (keywords, filters, sources, area if Marketplace is enabled)
  -> per enabled source: keyword search (eBay Browse; Bright Data snapshot, collected later)
  -> cheap filters (excluded keywords, price range, condition, seller rating, buying format)
  -> LLM extraction: is this plausibly the searched-for item, plus the attributes the
     watch's constraints ask about
  -> constraint check (freeform key/operator/value against extracted attributes)
  -> single Discord alert to the watch's channel, or silent storage if rejected
```

The model proposes interpretation and extracts evidence; server-side schemas validate the result. Search requests, credentials, filters, storage and notification decisions stay in application code. Listing text is untrusted data; models have no tools or transaction capabilities. Prompts receive listing title, limited description, item specifics and condition, not seller personal data or application credentials. Marketplace text is redacted (email, phone, street address) before storage or LLM calls.

Vague queries are previewed with explicit defaults, proposed numeric interpretations and unresolved questions. A user can edit before saving. The full JSON attachment prevents long configurations from being hidden by Discord message limits. A confirmation stores exactly the previewed configuration. Drafts are durable, user/server-bound, expire after 15 minutes and can only be consumed once; edits to an existing watch use a revision check. `/watch update` replaces keywords and filters; unstated sources, search area and price limits carry over, as do the channel and frequency.

Core acceptance coverage:

| Capability                                 | Implementation                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Natural-language watches with confirmation | Gemini/OpenAI → Zod → persisted preview → confirmation/edit/cancel                           |
| Cross-source keyword search                | Both sources by default; `sources` option opts out; disabled legs skipped per watch          |
| Authorized listing sources                 | eBay OAuth client credentials and Browse search/item details; Bright Data behind a kill flag |
| Scheduling                                 | Cron-driven queue, persisted watch interval; Marketplace hourly, max 5 active watches        |
| Store/deduplicate                          | Source ID primary key, normalization cache by evidence/intent hash, watch/listing uniqueness |
| LLM extraction                             | Validated JSON, model/prompt metadata, failures pending retry                                |
| Matching                                   | One pass/fail decision from filters, relevance and attribute constraints                     |
| Discord alerts                             | Single-tier embed: source, price, condition, matched criteria, pickup area, warnings         |
| Review/dismiss                             | Owner-bound Reviewed/Save/Dismiss/Not relevant buttons and slash commands                    |
| Failure visibility                         | Structured events and pending/delivery status records                                        |
| No transactions                            | No offer, bid, checkout or payment integration                                               |

Auctions and Buy It Now are both watched when the watch's `buying` filter allows them; current bids are labeled provisional. Marketplace listings carry verification warnings for deposit, wire-transfer, gift-card, crypto, stock-photo and shipping-only language. These warn; they never block a match or accuse a seller.

Known gaps are deliberate: Bright Data returns results in no guaranteed order, so small frequent polls can miss some new listings; no relist similarity detection, digest or near-end repeat alerts, automatic rule learning or administrator notifications. Credential-dependent live acceptance must be checked on the target accounts before declaring production ready.

Provider references used for implementation:

- [eBay Browse overview](https://developer.ebay.com/api-docs/buy/api-browse.html)
- [eBay Buy requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html)
- [eBay API limits](https://developer.ebay.com/develop/get-started/api-call-limits)
- [Gemini generateContent REST reference](https://ai.google.dev/api/generate-content)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
