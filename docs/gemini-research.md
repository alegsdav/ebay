# Gemini model choice

Checked **September 24, 2026** against Google's current Gemini Developer API documentation.

## Is Gemini 2.5 Flash deprecated?

Google currently says the 2.5 models are **not deprecated**, with no announced shutdown date for `gemini-2.5-flash`. However, access is now limited to users who previously used them. Google recommends **3.8 Flash or 3.5 Flash-Lite for new projects**. Some 2.5 preview and image variants have separate shutdown schedules. The earlier default was therefore a poor choice for a new account even though the exact stable text-model name is not listed as shut down. [Lifecycle table](https://ai.google.dev/gemini-api/docs/deprecations).

## What this repository uses

The default is now `gemini-3.8-flash`, configurable through `LLM_MODEL`. This bot needs structured extraction and query interpretation, not image generation or a Live API model. Google lists free input/output usage for the standard tier of 3.8 Flash; quotas and account/region eligibility still apply. The free tier permits content use for product improvement. [Pricing](https://ai.google.dev/gemini-api/docs/pricing).

`gemini-3.5-flash-lite` is an alternative to evaluate for this relatively small extraction workload. It is also listed with free-tier usage and lower paid token prices. I have not run a live accuracy comparison using your account, so I am not claiming equal quality. Start with the default, review false matches, then compare Flash-Lite using the same saved listing fixtures if needed.

## Your steps

1. Open [Google AI Studio](https://aistudio.google.com/) and create/select an API project.
2. Create an API key. For a free-tier trial, avoid enabling paid billing unless you deliberately want paid usage.
3. Put `GEMINI_API_KEY` and `LLM_MODEL=gemini-3.8-flash` in `.env.supabase`, then upload the secrets using the Supabase guide.
4. To check your own account's model access, also set those values in the ignored local `.env` and run:

   ```sh
   npm run check:model
   ```

   This retrieves model metadata; it does not generate content or run a paid benchmark. A successful lookup does not guarantee sufficient generation quota. Watch parsing in Discord verifies an actual structured-output request.

5. Look at the active limits in AI Studio rather than relying on a universal requests-per-minute number. Google says limits depend on usage tier and can vary. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

The code imposes a persistent daily request budget (300 by default), limits generated output, caches unchanged item extraction, and stores model/prompt versions. These are request controls, not a currency-denominated spend cap. Requests from other apps using your account are not counted by this bot. API 429 responses defer work instead of falling back to a paid model automatically.

This implementation uses the Gemini Developer API at `generativelanguage.googleapis.com`. Vertex AI and third-party resellers can have different access and lifecycle policies; a notice for those products is not necessarily a shutdown of this exact endpoint.
