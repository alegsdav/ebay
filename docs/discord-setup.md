# Discord bot setup — step by step

This guide configures Auction Scout for **Supabase hosting**. You do not need an always-on computer or a Discord gateway process. Discord sends signed HTTPS requests to your Supabase Edge Function.

## 1. Create the application

1. Sign in to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**. Name it **Auction Scout** (or your preferred name), accept the terms, and create it.
3. Open **General Information**. Copy **Application ID** and **Public Key** into your local `.env.supabase` file as `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`.
4. Open **Bot**. Create a bot if prompted. Under its token controls, click **Reset Token** or **View Token** as available, then save the token as `DISCORD_TOKEN`.
5. Leave all **Privileged Gateway Intents** off. This bot does not read general chat, presence or the member stream.
6. If this is for your own server, disable **Public Bot** if the portal allows it for your installation configuration.

The public key verifies incoming requests. The bot token authenticates outgoing messages. They are different values. Never post the bot token in a channel, issue, screenshot or Git repository. If exposed, reset it and update the Supabase secret.

## 2. Find your server and user IDs

1. In the Discord app, go to **User Settings → Advanced → Developer Mode** and turn it on.
2. Right-click your server icon and choose **Copy Server ID**. Set `DISCORD_GUILD_ID`.
3. Right-click your own profile and choose **Copy User ID**. For a private bot, set `ALLOWED_USER_IDS` to this value.
4. To allow more people, add comma-separated user IDs. Each person can manage only their own watches and alerts. An empty allowlist permits members of the configured server; it does not permit other servers.

## 3. Invite the bot

In the Developer Portal, open **Installation** (or **OAuth2 → URL Generator**, depending on the portal layout):

1. Choose **Guild Install** for a server installation.
2. Select the scopes **bot** and **applications.commands**.
3. Select these bot permissions: **View Channels**, **Send Messages**, **Embed Links**, **Attach Files**.
4. Use the generated installation link and select your server. You need permission to add applications there.
5. Create a text channel such as `#watch-alerts`. Each watch posts its matches to one channel.
6. Check the channel's permission overrides. Both you and the bot must be able to view and send messages; the bot also needs embeds and attachments. An explicit channel deny can override permissions granted at installation.

Do not grant Administrator. Threads, DMs and announcement channels are not supported destinations in this version.

## 4. Deploy the Supabase functions

Follow [Supabase setup](supabase-setup.md) through database migration, setting secrets and deploying both functions. Keep `CLOUD_MONITORING_ENABLED=false` and `DRY_RUN=true` initially.

The function URL will be:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/discord-interactions
```

## 5. Connect Discord to the function

1. Return to **General Information** in the Developer Portal.
2. Paste the URL above into **Interactions Endpoint URL** and click **Save Changes**.
3. Discord sends a signed verification request. The function must reply successfully before Discord accepts the URL.

The repository deliberately sets `verify_jwt=false` for this function: Discord does not send a Supabase JWT. The handler instead verifies Discord's Ed25519 signature against the **exact request body** and checks timestamp freshness. Do not remove this signature verification.

If Discord rejects the URL, check:

- Function name and project reference are correct and the function was deployed.
- `DISCORD_PUBLIC_KEY` is the application's public key, not the bot token.
- All required secrets exist, including `WORKER_SECRET` and the application/server IDs.
- Supabase function logs show no startup error.
- The project is not paused and the function's JWT verification is disabled as in `supabase/config.toml`.

## 6. Register slash commands

On your computer, copy `.env.example` to `.env` and fill in only the Discord token, application ID and guild ID for this step. From the repository directory:

```sh
npm ci
npm run register
```

This registers the application commands **for your configured server**. It replaces this application's command set in that server; it does not touch other bots. Re-run after changing command definitions. You do not run `npm start` for the Supabase deployment.

## 7. Test the bot

1. In your Discord server, run `/alert test`. You should receive a **private, synthetic sample**, not a real listing opportunity. The gateway online indicator is not a health check: this HTTP-only bot can work while Discord displays it as offline.
2. Run `/stats`. Initially you should have zero watches, with monitoring off and dry-run on.
3. With your Gemini key configured, try:

   ```text
   /watch create query: wireless gaming mice under $80, new or open box
   ```

   The watch searches eBay and Facebook Marketplace by default. Add `sources:eBay only` or `sources:Facebook Marketplace only` to opt out of one. Marketplace needs `/defaults` (city or ZIP, radius, delivery) first.

4. The bot acknowledges the command promptly, then processes it through the queue. It returns a preview (keywords, sources, price range, filters, channel) and `watch-preview.json` with the complete rules.
5. Read the preview. **Edit query** opens a modal for a complete replacement request. **Cancel** discards it. **Confirm watch** saves it. Preview buttons expire after 15 minutes and work only for their creator.
6. Use `/watch list` to copy the saved watch ID. `/settings id:… max_price:… frequency:… channel:…` previews price-range, frequency or channel changes; confirm that preview too.
7. `/watch pause`, `/watch resume`, `/watch update` and `/watch delete` manage it. `/watch update` replaces the keywords and filters; sources, search area and price limits carry over unless the new query states them. `/listing saved` retrieves saved alerts; `/listing details` accepts the alert ID from an alert footer.

## 8. Enable actual monitoring

Finish the [eBay setup](ebay-data-options.md) and install the Supabase Cron schedule. Set `CLOUD_MONITORING_ENABLED=true` while keeping `DRY_RUN=true`. Review function logs and `scout_processing` in the Supabase Table Editor. Then change `DRY_RUN=false` when ready for match posts. Keep `FACEBOOK_MONITORING_ENABLED=false` until the Bright Data connector is implemented; the eBay leg of every watch runs normally meanwhile.

A listing that fails a filter, is judged not relevant, or lacks evidence for a required attribute is stored silently. A working `/alert test` verifies Discord presentation, not marketplace access or match quality.

## Troubleshooting

| Symptom                                            | What to check                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slash commands do not appear                       | Correct server/application IDs, install scope, registration result; reload Discord.                                                                          |
| “Application did not respond”                      | Interactions endpoint, signature key, function logs, paused Supabase project or slow database response. Initial acknowledgement must occur within 3 seconds. |
| Command stays “thinking”                           | `scout_jobs` and worker logs; worker secret must match Vault; Cron must be running. Interaction tokens are short-lived.                                      |
| Preview works but no alerts                        | Monitoring flag, dry-run flag, eBay credentials/approval, source errors and `scout_processing` rejection reasons.                                            |
| Permission error                                   | Check channel-specific user and bot overrides, not just the bot's server role.                                                                               |
| One person cannot use the bot                      | Check `ALLOWED_USER_IDS` and watch ownership.                                                                                                                |
| No automatic retry after an uncertain Discord post | Inspect `scout_alerts`: ambiguous deliveries are held to avoid duplicate alerts.                                                                             |

Reference: [Discord interactions and response deadlines](https://docs.discord.com/developers/interactions/receiving-and-responding).
