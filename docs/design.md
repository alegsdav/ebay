# Design decisions and acceptance coverage

The hosted architecture uses Supabase PostgreSQL, signed Discord HTTP interactions, leased queue jobs, Edge Functions and Cron. It is the only deployment target. See [the deployment guide](supabase-setup.md).

The bot is an eBay keyword watcher: each watch posts each new matching listing once to its channel. There is no fixed category list, sold-price comparison, profit or discount math, or strong/possible tiering.

```text
watch (keywords, filters)
  -> eBay Browse keyword search, newest first
  -> cheap filters (excluded keywords, price range, condition, seller rating, buying format)
  -> skip listings this watch already checked
  -> fresh item detail
  -> LLM extraction: does this listing plausibly match the search, plus whatever
     attributes the watch's constraints ask about (no fixed category vocabulary)
  -> constraint check (freeform key/operator/value against extracted attributes)
  -> single Discord alert to the watch's channel, or silent storage if rejected
```

The model proposes interpretation and extracts evidence; server-side schemas validate the result. Search requests, credentials, filters, storage and notification decisions stay in application code. Listing text is untrusted data; models have no tools or transaction capabilities. Prompts receive listing title, limited description, item specifics and condition, not seller personal data or application credentials.

Vague queries are previewed with explicit defaults, proposed numeric interpretations and unresolved questions. A user can edit before saving. The full JSON attachment prevents long configurations from being hidden by Discord message limits. A confirmation stores exactly the previewed configuration. Drafts are durable, user/server-bound, expire after 15 minutes and can only be consumed once; edits to an existing watch use a revision check. `/watch update` replaces keywords and filters; unstated price limits, the channel and the frequency carry over.

Core acceptance coverage:

| Capability                                 | Implementation                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Natural-language watches with confirmation | Gemini/OpenAI → Zod → persisted preview → confirmation/edit/cancel                         |
| Authorized listing source                  | eBay OAuth client credentials, Browse keyword search and item details                      |
| Scheduling                                 | Cron-driven queue, persisted watch interval (hourly default)                               |
| Store/deduplicate                          | Source ID primary key, per-watch processed listings, normalization cache, alert uniqueness |
| LLM extraction                             | Validated JSON, model/prompt metadata, failures pending retry                              |
| Matching                                   | One pass/fail decision from filters, relevance and attribute constraints                   |
| Discord alerts                             | Single-tier embed: price, shipping, condition, matched criteria, seller, warnings          |
| Diagnostics                                | Optional debug channel: search results and the reason for every decision                   |
| Review/dismiss                             | Owner-bound Reviewed/Save/Dismiss/Not relevant buttons and slash commands                  |
| No transactions                            | No offer, bid, checkout or payment integration                                             |

Auctions and Buy It Now are both watched when the watch's `buying` filter allows them; current bids are labeled provisional.

Facebook Marketplace support (via Bright Data) was built, tested live and removed on September 28, 2026: its keyword search did not reliably return Facebook's own results. The removal migration deletes all Marketplace data.

Known gaps: no relist similarity detection, digest or near-end repeat alerts, automatic rule learning or administrator notifications. Credential-dependent live acceptance must be checked on the target accounts before declaring production ready.

Provider references used for implementation:

- [eBay Browse overview](https://developer.ebay.com/api-docs/buy/api-browse.html)
- [eBay Buy requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html)
- [eBay API limits](https://developer.ebay.com/develop/get-started/api-call-limits)
- [Gemini generateContent REST reference](https://ai.google.dev/api/generate-content)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
