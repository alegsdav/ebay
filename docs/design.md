# V1 design decisions and acceptance coverage

The hosted architecture now uses Supabase PostgreSQL, signed Discord HTTP interactions, leased queue jobs, Edge Functions and Cron. The original local gateway/SQLite implementation remains available for offline development. See [the deployment guide](supabase-setup.md).

The multi-category revision of the PRD is authoritative. This build uses a shared watch and pricing pipeline, with category templates controlling allowable attribute names, marketplace categories, identity matching and risk signals.

The model proposes interpretation and extracts evidence; server-side schemas validate the result. Search IDs, URLs used for API access, credentials, arithmetic, thresholds, storage and notification decisions stay in application code. Listing text is untrusted data; models have no tools or transaction capabilities. Prompts receive listing title, limited description, item specifics and condition, not seller personal data or application credentials.

Vague queries are previewed with explicit defaults and unresolved questions. A user can edit before saving. The full JSON attachment prevents long configurations from being hidden by Discord message limits. A confirmation stores exactly the previewed configuration. Drafts are durable, user/server-bound, expire after 15 minutes and can only be consumed once; edits to an existing watch use a revision check.

Core acceptance coverage:

| PRD capability                             | Implementation                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Natural-language watches with confirmation | Gemini/OpenAI → Zod → persisted preview → confirmation/edit/cancel                  |
| Multiple categories                        | Six templates, validated taxonomy IDs; exact scope in operations guide              |
| Authorized listing source                  | eBay OAuth client credentials, Browse search/item details, Taxonomy validation      |
| Hourly scheduling                          | Process scheduler plus SQLite lease and persisted watch interval                    |
| Store/deduplicate                          | Source ID primary key, normalized evidence hash, watch/listing alert uniqueness     |
| LLM normalization                          | Validated JSON, model/prompt metadata, failures pending retry                       |
| Comparable sale records                    | Transactional validated imports with source evidence and deduplication              |
| Financial calculations                     | Integer cents, delivered-sale median, fee/tax/reserve breakdown and modeled bid cap |
| Discord alerts and evidence                | Embeds, source/evidence links, details JSON, warnings, confidence and tiers         |
| Review/dismiss                             | Owner-bound buttons and slash commands, persistent feedback                         |
| Failure visibility                         | Structured events and pending/delivery status records                               |
| No transactions                            | No offer, bid, checkout or payment integration                                      |

An alert may be strong only when hard watch filters pass, comparable count is adequate, discount/profit thresholds pass, extraction confidence meets the watch minimum, comparable spread is not excessive, and no extraction/risk warnings remain. Possible matches use a separate opt-in channel. Missing pricing evidence stays silent. Auction prices are always labeled provisional.

Known gaps from the broader PRD are deliberate and documented: no paid sold-data connector chosen, no relist similarity detection, no digest/near-end repeat alert, no automatic rule learning or administrator notifications. Supabase-specific SQL and handler tests complement the local tests. Credential-dependent live acceptance must be checked on the target accounts before declaring production ready.

Provider references used for implementation:

- [eBay Browse overview](https://developer.ebay.com/api-docs/buy/api-browse.html)
- [eBay Buy requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html)
- [eBay API limits](https://developer.ebay.com/develop/get-started/api-call-limits)
- [Gemini generateContent REST reference](https://ai.google.dev/api/generate-content)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
