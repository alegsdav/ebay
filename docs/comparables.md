# Completed-sale evidence

Browse search results are active asking prices or current bids. They are **not** sold-price comparables. This version imports JSON records supplied by the operator from sources they are permitted to use. It does not scrape sold-history pages or ask the model to invent sale evidence.

```sh
npm run import:cloud -- /absolute/path/to/verified-sales.json
```

For local SQLite development only, use `npm run import:comparables` instead. The cloud command requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your ignored local `.env`.

The file must contain a JSON array. Every row is validated; malformed or future-dated input aborts the whole import. Re-importing a source ID or a source URL is a no-op. URL query strings and fragments do not create additional comparables. Use a distinct stable path for each actual completed sale; a provider whose sale identity exists only in query parameters needs an adapter before importing.

Illustrative shape below — replace every example field with real, verified evidence. This is not a sale recommendation or a real transaction:

```json
[
  {
    "id": "provider-sale-id",
    "source": "your-permitted-provider",
    "sourceUrl": "https://provider.example/sales/unique-sale-id",
    "saleDate": "2026-09-01T12:00:00.000Z",
    "retrievedAt": "2026-09-02T12:00:00.000Z",
    "salePrice": 95,
    "shipping": 5,
    "currency": "USD",
    "category": "gaming_mice",
    "condition": "open_box",
    "attributes": [
      { "key": "brand", "value": "example brand" },
      { "key": "model", "value": "example model" },
      { "key": "revision", "value": "2" },
      { "key": "connectivity", "value": "wireless" },
      { "key": "receiver_included", "value": "yes" },
      { "key": "bundle", "value": "none" }
    ],
    "evidence": "verified_completed_sale"
  }
]
```

`verified_completed_sale` is the operator's attestation, not an automatic authenticity check. Do not import asking prices, unaccepted offers, canceled transactions, or unsold auctions. `salePrice` is the item's completed price; `shipping` is the buyer's delivery charge. Both must be known; zero shipping means explicitly free shipping. The comparable basis is delivered price **excluding buyer tax**. Buyer tax and fees are applied separately to the candidate listing. Fee math assumes seller fees apply to this delivered resale total; adjust fee estimates for your situation.

Exact comparable keys:

| Category        | Required matching keys                                              |
| --------------- | ------------------------------------------------------------------- |
| `gaming_mice`   | brand, model, revision, connectivity, receiver_included, bundle     |
| `pokemon_cards` | set, card_number, grade, grader, language, edition, variant         |
| `gpus`          | brand, model, vram_gb, revision, functional, bundle                 |
| `camera_lenses` | brand, model, mount, focal_length, aperture, autofocus, accessories |
| `sneakers`      | brand, model, style_code, size, size_system, colorway, box_included |
| `power_tools`   | brand, model, voltage, battery_included, charger_included, bundle   |

Use lowercase categorical values; comparison trims and lowercases them. Boolean attributes are `yes` or `no`, numbers are decimal strings in the units named by the key. Use `none` only when an absence is supported by evidence, and `unknown` for missing information. An unknown required identity field excludes the record from matching. Conditions are `new`, `open_box`, `used`, `refurbished`, `for_parts`, or `unknown`; candidate and comparable conditions must match exactly. Default watches exclude for-parts and unknown conditions.

Default matching requires five distinct completed sales in the past 90 days. A wide price range or extraction warnings reduces the alert tier. The score ranks candidates; it does not establish authenticity or a guaranteed resale outcome. Feedback does not automatically rewrite comparable records or category rules.

Import corrections currently require stopping the bot and removing the incorrect record before re-importing, or using a new verified source record. Preserve source evidence when correcting records. There is no automatic external sold-data refresh adapter in V1; periodically import new verified evidence.
