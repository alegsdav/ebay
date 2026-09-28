# eBay access and third-party data options

Research checked **September 24, 2026**. The bot monitors **active listings** by keyword and notifies on matches; it does not estimate resale value, so completed-sale data is not needed.

## Recommended path: eBay's own API for active listings

Yes: for the connector implemented here, you need an **eBay Developers Program account and your own application keys**. Developer membership is free. Browse search uses an application access token obtained through OAuth client credentials; this bot does not require your buyer password or authorization to bid. [Developer onboarding](https://developer.ebay.com/develop/guides/sell/get-started-with-ebay-apis), [Browse overview](https://developer.ebay.com/api-docs/buy/api-browse.html).

Sandbox keys let you test against sandbox data. Real monitoring requires production keys and the applicable Buy API production access. eBay's published requirements describe eligibility review, approvals and agreements; do not assume creating a production keyset automatically approves this research/alerting use case. Describe it accurately when contacting developer support. [Buy API requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html).

The published default Browse allowance is 5,000 calls/day for methods other than `getItems`, with `getItems` listed separately. The bot uses search/detail calls and defaults to a conservative 4,000-attempt daily budget. This is a quota, not a promise of unlimited access or approval. Verify the limits assigned to your application. [Call limits](https://developer.ebay.com/develop/get-started/api-call-limits).

### Steps for your account

1. Join the [eBay Developers Program](https://developer.ebay.com/) and complete account verification.
2. Create a sandbox keyset and, when available, a production keyset.
3. Set `EBAY_CLIENT_ID` to the App ID/client ID and `EBAY_CLIENT_SECRET` to the Cert ID/client secret. Keep the environment and matching keyset together.
4. Set `EBAY_POSTAL_CODE` to your US delivery ZIP so shipping costs shown in alerts have a destination.
5. Start with `EBAY_ENV=sandbox`. Sandbox listings are test data, not items to purchase.
6. Read the Buy API production requirements and request approval/clarification for your app where required. Describe: “A read-only, private Discord listing monitor with human review; no bidding, checkout or payment handling; marketplace text is normalized using an external LLM.” Ask whether your intended retention, LLM processing and alert display are permitted under your agreement.
7. After access is approved, switch to `EBAY_ENV=production`, use production credentials, and run a narrow watch in dry-run.
8. Leave `EBAY_ALLOW_AUCTIONS=false` until you have confirmed auction access for your integration. With it enabled, a watch whose `buying` filter is `auction` or `both` also watches auctions. The code has no purchasing or bidding endpoint regardless of this flag.

## Third-party alternatives

These are researched options, **not installed connectors or verified eBay-authorized data licenses**. A vendor's public scraping API and a recurring free tier do not themselves establish permission to use or redistribute eBay data in this application.

| Option                       | Free offering found                                   | What it changes                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SerpApi eBay Search API**  | 250 searches/month on its published Free plan         | You use a SerpApi account/key rather than eBay application credentials for this provider. It exposes parsed eBay search results. Confirm coverage and permitted use before integrating. |
| **SearchApi**                | Advertises 100 free requests at signup                | Treat this as a trial allocation, not a verified recurring monthly eBay allowance. Confirm its current eBay product availability and fields before choosing it.                         |
| **eBay Product Research UI** | Available free to eligible sellers through Seller Hub | Useful for human market research, but the UI is not a public bot API and this project does not automate or scrape it.                                                                   |

Sources: [SerpApi pricing](https://serpapi.com/pricing), [SerpApi eBay API](https://serpapi.com/ebay-search-api), [SearchApi pricing](https://www.searchapi.io/pricing), [eBay Product Research](https://www.ebay.com/help/selling/selling-tools/product-research?id=4853).

At one query per hour, one watch needs about **720 searches per 30-day month**, before pagination or detail lookups. A 250-search free tier therefore cannot cover even one continuously hourly watch at that rate. It may be enough for a small proof of concept with much slower polling. Two watches at hourly frequency need at least 1,440 searches/month. These are simple volume estimates, not provider quotes.

I recommend pursuing official eBay access first. Consider a third-party provider only after you have verified its allowed use, real fields, free/paid limits and evidence quality. This repository deliberately has no automatic fallback to scraping, proxy rotation or CAPTCHA services.
