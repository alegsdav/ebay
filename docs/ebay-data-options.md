# eBay access and third-party data options

Research checked **September 24, 2026**. The key distinction is **active listings to monitor** versus **verified completed sales to estimate value**. Access to one does not imply access to the other.

## Recommended path: eBay's own API for active listings

Yes: for the connector implemented here, you need an **eBay Developers Program account and your own application keys**. Developer membership is free. Browse search uses an application access token obtained through OAuth client credentials; this bot does not require your buyer password or authorization to bid. [Developer onboarding](https://developer.ebay.com/develop/guides/sell/get-started-with-ebay-apis), [Browse overview](https://developer.ebay.com/api-docs/buy/api-browse.html).

Sandbox keys let you test against sandbox data. Real monitoring requires production keys and the applicable Buy API production access. eBay's published requirements describe eligibility review, approvals and agreements; do not assume creating a production keyset automatically approves this research/alerting use case. Describe it accurately when contacting developer support. [Buy API requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html).

The published default Browse allowance is 5,000 calls/day for methods other than `getItems`, with `getItems` listed separately. The bot uses search/detail calls and defaults to a conservative 4,000-attempt daily budget. This is a quota, not a promise of unlimited access or approval. Verify the limits assigned to your application. [Call limits](https://developer.ebay.com/develop/get-started/api-call-limits).

### Steps for your account

1. Join the [eBay Developers Program](https://developer.ebay.com/) and complete account verification.
2. Create a sandbox keyset and, when available, a production keyset.
3. Set `EBAY_CLIENT_ID` to the App ID/client ID and `EBAY_CLIENT_SECRET` to the Cert ID/client secret. Keep the environment and matching keyset together.
4. Set `EBAY_POSTAL_CODE` to your US delivery ZIP so shipping estimates have a destination.
5. Start with `EBAY_ENV=sandbox`. Sandbox listings are test data, not deals to purchase.
6. Read the Buy API production requirements and request approval/clarification for your app where required. Describe: “A read-only, private Discord listing monitor with human review; no bidding, checkout or payment handling; marketplace text is normalized using an external LLM.” Ask whether your intended retention, LLM processing and alert display are permitted under your agreement.
7. After access is approved, switch to `EBAY_ENV=production`, use production credentials, and run a narrow watch in dry-run.
8. Leave `EBAY_ALLOW_AUCTIONS=false` until you have confirmed auction access for your integration. The code has no purchasing or bidding endpoint regardless of this flag.

## Third-party alternatives

These are researched options, **not installed connectors or verified eBay-authorized data licenses**. A vendor's public scraping API and a recurring free tier do not themselves establish permission to use or redistribute eBay data in this application.

| Option                       | Free offering found                                   | What it changes                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SerpApi eBay Search API**  | 250 searches/month on its published Free plan         | You use a SerpApi account/key rather than eBay application credentials for this provider. It exposes parsed eBay search results. Confirm coverage, permitted use and completed-sale evidence before integrating. |
| **SearchApi**                | Advertises 100 free requests at signup                | Treat this as a trial allocation, not a verified recurring monthly eBay allowance. Confirm its current eBay product availability and fields before choosing it.                                                  |
| **eBay Product Research UI** | Available free to eligible sellers through Seller Hub | Useful for human market research, but the UI is not a public bot API and this project does not automate or scrape it.                                                                                            |

Sources: [SerpApi pricing](https://serpapi.com/pricing), [SerpApi eBay API](https://serpapi.com/ebay-search-api), [SearchApi pricing](https://www.searchapi.io/pricing), [eBay Product Research](https://www.ebay.com/help/selling/selling-tools/product-research?id=4853).

At one query per hour, one watch needs about **720 searches per 30-day month**, before pagination, detail lookups or comparable searches. A 250-search free tier therefore cannot cover even one continuously hourly watch at that rate. It may be enough for a small proof of concept with much slower polling. Two watches at hourly frequency need at least 1,440 searches/month. These are simple volume estimates, not provider quotes.

I recommend pursuing official eBay access first. Consider a third-party provider only after you have verified its allowed use, real fields, free/paid limits and evidence quality. This repository deliberately has no automatic fallback to scraping, proxy rotation or CAPTCHA services.

## Completed-sale prices remain a separate dependency

Browse is for current listings. It should not be treated as an unrestricted historical sold-price service. eBay's Marketplace Insights documentation redirects to a private/sign-in area; I could not establish open self-service access for a new account. Do not plan V1 around guaranteed access to it. [Marketplace Insights entry](https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html).

If a provider returns “sold” search results, verify what the price actually represents: an accepted offer may differ from the displayed asking price, delivery may be omitted, and canceled/duplicate results may be present. A sold label alone is not enough to declare an exact comparable.

Until you have a suitable authorized sold-data source, import your own permitted, verified sale records. The cloud importer validates the format and records provenance; you remain responsible for whether the evidence is actually a completed sale. See [comparable format and import](comparables.md). Without sufficient matching sales, candidates are stored silently and no market value is invented.
