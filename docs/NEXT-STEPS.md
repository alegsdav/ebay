# Your next steps — eBay keyword watches

Updated September 28, 2026.

The bot watches eBay only. Facebook Marketplace (Bright Data) was removed after live
tests showed its keyword search did not reliably return Facebook's own results.

## Current state

- Deployed and monitoring is on, but **no eBay keys are set**, so scans do nothing.
- Your two watches ("Lofree Flow Keyboard", "HD 560S") are eBay-only and will start
  searching as soon as keys are added.
- `#debug-console` shows each eBay search and why every listing was pinged or skipped.

## Your next manual actions

1. In the [eBay developer portal](https://developer.ebay.com/my/keys), copy your keyset.
   Put these in the Git-ignored `.env.supabase` (do not paste the Cert ID in chat):

   ```dotenv
   EBAY_ENV=production        # or sandbox; must match the keyset
   EBAY_CLIENT_ID=<App ID>
   EBAY_CLIENT_SECRET=<Cert ID>
   EBAY_POSTAL_CODE=<your ZIP>
   ```

   The Dev ID is not needed.

2. Tell the assistant the keys are saved. It will run `npm run check:ebay`, upload only
   the eBay secrets to Supabase and watch the first scan in `#debug-console`.
3. Clean up leftovers from the Facebook experiment (see the handoff list): remove the
   Bright Data lines from `.env.supabase` and revoke the Bright Data API key.
