import { cloudConfig, type CloudConfig } from "./config.js";
import { CloudStore, type Job } from "./store.js";
import { CloudCommands, authorized } from "./commands.js";
import {
  actor,
  DiscordHttp,
  alertMessage,
  clean,
  type Interaction,
} from "./discord.js";
import { LlmClient, PROMPT_VERSION } from "../llm/client.js";
import { EbaySource } from "../connectors/ebay.js";
import { Listing } from "../config/schema.js";
import { basicReject } from "../filters/matches.js";
import { evaluateMatch, minExtractionConfidence } from "../filters/evaluate.js";
import { HttpError } from "../connectors/http.js";
import { log, errorKind } from "../logging.js";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (v) => parseInt(v, 16));
export async function verifyDiscord(
  body: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
  now = Date.now(),
) {
  if (
    !signature ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !/^\w{128}$/.test(signature) ||
    !/^[a-fA-F0-9]{128}$/.test(signature) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      bytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}
export function interactionsHandler(
  c: CloudConfig,
  waitUntil: (p: Promise<unknown>) => void,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body = await req.text();
    if (body.length > 131072) return new Response("Too large", { status: 413 });
    if (
      !(await verifyDiscord(
        body,
        req.headers.get("x-signature-ed25519"),
        req.headers.get("x-signature-timestamp"),
        c.DISCORD_PUBLIC_KEY,
      ))
    )
      return new Response("Invalid signature", { status: 401 });
    let i: Interaction;
    try {
      i = JSON.parse(body);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    if (i.type === 1) return json({ type: 1 });
    try {
      authorized(i, c);
      const db = new CloudStore(
        c.SUPABASE_URL,
        c.SUPABASE_SERVICE_ROLE_KEY,
        AbortSignal.timeout(2200),
      );
      if (i.type === 3 && String(i.data?.custom_id).startsWith("draft:edit:")) {
        const id = String(i.data.custom_id).split(":")[2]!;
        const d = await db.draft(id, actor(i), i.guild_id!);
        return json({
          type: 9,
          data: {
            custom_id: `edit:${id}`,
            title: "Edit watch query",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "query",
                    label: "Complete watch request",
                    style: 2,
                    required: true,
                    max_length: 2000,
                    value: d.query,
                  },
                ],
              },
            ],
          },
        });
      }
      if (![2, 3, 5].includes(i.type))
        return json({
          type: 4,
          data: { content: "Unsupported interaction.", flags: 64 },
        });
      await db.enqueue([
        { dedupe_key: `interaction:${i.id}`, kind: "interaction", payload: i },
      ]);
      // The durable queue is authoritative; Cron retries even if this wake-up is interrupted.
      waitUntil(
        fetch(`${c.SUPABASE_URL}/functions/v1/scout-worker`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.WORKER_SECRET}` },
          signal: AbortSignal.timeout(110000),
        })
          .then(() => {})
          .catch(() => {}),
      );
      return json(
        i.type === 3 && String(i.data?.custom_id).startsWith("draft:")
          ? { type: 6 }
          : { type: 5, data: { flags: 64 } },
      );
    } catch (error) {
      log("interaction_ingress_failure", { error: errorKind(error) });
      return json({
        type: 4,
        data: {
          content:
            error instanceof Error && error.name === "Error"
              ? error.message
              : "Could not queue this request. Please try again.",
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      });
    }
  };
}
async function digest(data: unknown) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return Array.from(new Uint8Array(hash), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function processJob(
  job: Job,
  c: CloudConfig,
  db: CloudStore,
  signal: AbortSignal,
) {
  const discord = new DiscordHttp(
    c.env.DISCORD_TOKEN,
    c.env.DISCORD_APPLICATION_ID,
    signal,
  );
  const llm = () =>
    new LlmClient(
      c.env,
      () => db.budget("llm", c.env.MAX_LLM_CALLS_PER_DAY),
      signal,
    );
  if (job.kind === "interaction") {
    const i = job.payload as Interaction;
    const interpreter = {
      model: `${c.env.LLM_PROVIDER}/${c.env.LLM_MODEL}`,
      parseWatch: (...args: Parameters<LlmClient["parseWatch"]>) =>
        llm().parseWatch(...args),
      normalize: (...args: Parameters<LlmClient["normalize"]>) =>
        llm().normalize(...args),
    };
    const commands = new CloudCommands(db, discord, interpreter, c);
    try {
      await discord.edit(i, await commands.run(i));
    } catch (error) {
      if (error instanceof HttpError && error.status === 429)
        await db.cooldown(
          error.service === "gemini" || error.service === "openai"
            ? "llm"
            : error.service,
          error.retryAt,
        );
      await discord.edit(i, {
        content:
          error instanceof Error && error.name === "Error"
            ? error.message
            : "Request failed validation or a service is unavailable. Retry later; see function logs.",
        components: [],
      });
      throw error;
    }
    return;
  }
  if (!c.CLOUD_MONITORING_ENABLED) return;
  const w = await db.watch(job.payload.watchId);
  // Only scans are tied to a revision; queued listings are evaluated against the
  // current config so an edit, pause or resume never silently drops them.
  if (
    !w ||
    !w.active ||
    (job.kind === "scan" && w.revision !== job.payload.revision)
  )
    return;
  const debug = debugFeed(c, discord, w.config.name);
  if (!(
    c.env.EBAY_CLIENT_ID &&
    c.env.EBAY_CLIENT_SECRET &&
    c.env.EBAY_POSTAL_CODE
  )) {
    if (job.kind === "scan")
      log("cloud_scan_skipped", { reason: "ebay_not_configured" });
    return;
  }
  const ebay = new EbaySource(
    { ...c.env, MAX_PAGES_PER_WATCH: 1 },
    () => db.budget("ebay", c.env.EBAY_MAX_CALLS_PER_DAY),
    signal,
  );
  if (job.kind === "scan") return scan(job, w, ebay, c, db, debug);
  let listing = Listing.parse(job.payload.listing);
  await db.saveListing(listing);
  try {
    // All queued candidates are refreshed; never alert using the queued snapshot.
    listing = await ebay.detail(listing);
    await db.saveListing(listing);
    const reject = basicReject(listing, w.config);
    if (reject) {
      await db.process(w.id, listing.id, "filtered", { reason: reject });
      await debug(`⛔ filtered (${reject}): ${describe(listing)}`);
      return;
    }
    const model = llm();
    const hash = await digest({
      title: listing.title,
      description: listing.description,
      specifics: listing.specifics,
      condition: listing.condition,
      // Relevance and extracted keys depend on what the watch searches for.
      intent: {
        searchTerms: w.config.searchTerms,
        keys: [...new Set(w.config.constraints.map((k) => k.key))].sort(),
      },
      model: model.model,
      prompt: PROMPT_VERSION,
    });
    let n = await db.normalized(listing.id, hash);
    if (!n) {
      n = await model.normalize(listing, w.config);
      if (n.confidence >= minExtractionConfidence)
        await db.upsert(
          "scout_normalized",
          {
            listing_id: listing.id,
            hash,
            data: n,
            model: model.model,
            prompt_version: PROMPT_VERSION,
            created_at: new Date().toISOString(),
          },
          "listing_id,hash",
        );
    }
    const match = evaluateMatch(listing, n, w.config);
    if (!match.matched) {
      await db.process(w.id, listing.id, "rejected", {
        reason: match.reason,
        warnings: match.warnings,
      });
      await debug(`❌ skipped (${match.reason}): ${describe(listing)}`);
      return;
    }
    await db.process(w.id, listing.id, "matched", {
      warnings: match.warnings,
    });
    const payload = { listing, normalized: n, match, config: w.config };
    if (c.env.DRY_RUN) {
      log("cloud_dry_run_alert", { watchId: w.id, listingId: listing.id });
      await debug(`🧪 match, dry-run so not posted: ${describe(listing)}`);
      return;
    }
    const id = await db.rpc("scout_reserve_alert", {
      p_watch: w.id,
      p_revision: w.revision,
      p_listing: listing.id,
      p_payload: payload,
    });
    if (!id) return;
    try {
      const message = await discord.send(
        w.config.channelId,
        alertMessage(payload, id),
        id,
      );
      await db.update(
        "scout_alerts",
        { id: `eq.${id}` },
        { status: "sent", message_id: message.id },
      );
      await debug(
        `✅ match, pinged in <#${w.config.channelId}>: ${describe(listing)}`,
      );
    } catch (error) {
      await db.update(
        "scout_alerts",
        { id: `eq.${id}` },
        { status: "delivery_unknown" },
      );
      log("cloud_delivery_unknown", { alertId: id, error: errorKind(error) });
      await debug(
        `⚠️ match, but the Discord post failed: ${describe(listing)}`,
      );
    }
  } catch (error) {
    await db.process(
      w.id,
      listing.id,
      error instanceof HttpError && [404, 410].includes(error.status)
        ? "unavailable"
        : "needs_processing",
      { error: errorKind(error) },
    );
    throw error;
  }
}
type ActiveWatch = NonNullable<Awaited<ReturnType<CloudStore["watch"]>>>;
type Debug = (text: string) => Promise<void>;
// Diagnostics for DEBUG_CHANNEL_ID: what each search returned and why each listing
// was pinged or skipped. Failures here never affect the pipeline.
function debugFeed(c: CloudConfig, discord: DiscordHttp, watch: string): Debug {
  const channel = c.env.DEBUG_CHANNEL_ID;
  return async (text) => {
    if (!channel) return;
    await discord
      .post(channel, {
        content: `**${clean(watch).slice(0, 80)}** · ${text}`.slice(0, 1900),
      })
      .catch((error) => log("debug_post_failure", { error: errorKind(error) }));
  };
}
function describe(l: Listing) {
  const listed = l.listedAt
    ? ` · listed <t:${Math.floor(Date.parse(l.listedAt) / 1000)}:R>`
    : "";
  return `[${clean(l.title).slice(0, 90)}](<${l.url}>) · $${l.price}${l.auction ? " (bid)" : ""}${listed}`;
}
async function scan(
  job: Job,
  w: ActiveWatch,
  ebay: EbaySource,
  c: CloudConfig,
  db: CloudStore,
  debug: Debug,
) {
  const candidates = new Map<string, Listing>();
  let returned = 0;
  try {
    for await (const l of ebay.search(w.config)) {
      returned++;
      if (!basicReject(l, w.config)) candidates.set(l.id, l);
      if (candidates.size >= c.CLOUD_ITEMS_PER_WATCH) break;
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 429)
      await db.cooldown(error.service, error.retryAt).catch(() => {});
    await debug(
      `⚠️ eBay search failed: ${errorKind(error)}${error instanceof HttpError ? ` (${error.service} HTTP ${error.status})` : error instanceof Error && error.name === "Error" ? ` (${clean(error.message).slice(0, 200)})` : ""}`,
    );
    throw error;
  }
  // Only listings this watch has not already processed are checked again.
  const fresh = [...candidates.values()];
  const seen = fresh.length
    ? new Set(
        (
          await db.rows("scout_processing", {
            watch_id: `eq.${w.id}`,
            listing_id: `in.(${fresh.map((l) => `"${l.id.replace(/["\\]/g, "")}"`).join(",")})`,
            select: "listing_id",
          })
        ).map((r) => String(r.listing_id)),
      )
    : new Set<string>();
  const queue = fresh.filter((l) => !seen.has(l.id));
  const old = await db.rows("scout_processing", {
    watch_id: `eq.${w.id}`,
    status: "eq.needs_processing",
    order: "updated_at.asc",
    limit: "10",
    select: "listing_id,scout_listings(data)",
  });
  for (const row of old) {
    const l = Listing.parse(row.scout_listings.data);
    if (!l.endTime || Date.parse(l.endTime) > Date.now()) queue.push(l);
  }
  const now = Date.now();
  await db.enqueue(
    queue.map((l, i) => ({
      dedupe_key: `listing:${job.id}:${l.id}`,
      kind: "listing" as const,
      payload: { watchId: w.id, revision: w.revision, listing: l },
      available_at: new Date(now + i * 1000).toISOString(),
    })),
  );
  log("cloud_scan_enqueued", {
    watchId: w.id,
    returned,
    candidates: candidates.size,
    queued: queue.length,
  });
  await debug(
    `🔎 eBay search "${clean(w.config.searchTerms)}": ${returned} result${returned === 1 ? "" : "s"} · ${candidates.size} passed filters · ${queue.length} new to check`,
  );
}
export function workerHandler(c: CloudConfig) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    if (req.headers.get("authorization") !== `Bearer ${c.WORKER_SECRET}`)
      return new Response("Unauthorized", { status: 401 });
    const cleanup = new CloudStore(c.SUPABASE_URL, c.SUPABASE_SERVICE_ROLE_KEY);
    let job: Job | undefined;
    try {
      if (c.CLOUD_MONITORING_ENABLED) await cleanup.rpc("scout_enqueue_due");
      job = (await cleanup.rpc("scout_claim_job"))[0];
      if (!job) return json({ idle: true });
      const signal = AbortSignal.timeout(95000);
      const db = new CloudStore(
        c.SUPABASE_URL,
        c.SUPABASE_SERVICE_ROLE_KEY,
        signal,
      );
      await processJob(job, c, db, signal);
      await cleanup.rpc("scout_finish_job", {
        p_id: job.id,
        p_lease: job.lease_token,
        p_status: "done",
      });
      return json({ processed: job.id });
    } catch (error) {
      log("cloud_job_failure", {
        jobId: job?.id,
        error: errorKind(error),
        ...(error instanceof HttpError
          ? { status: error.status, service: error.service }
          : {}),
      });
      if (job) {
        if (error instanceof HttpError && error.status === 429)
          await cleanup
            .cooldown(
              ["gemini", "openai"].includes(error.service)
                ? "llm"
                : error.service,
              error.retryAt,
            )
            .catch(() => {});
        // Discord actions are not replayed after a side effect; users can explicitly retry a failed command.
        const retry = job.kind !== "interaction" && job.attempts < 3;
        await cleanup
          .rpc("scout_finish_job", {
            p_id: job.id,
            p_lease: job.lease_token,
            p_status: retry ? "queued" : "dead",
            p_retry_at: new Date(
              error instanceof HttpError && error.retryAt > Date.now()
                ? error.retryAt
                : Date.now() + 60000 * job.attempts,
            ).toISOString(),
            p_error: errorKind(error),
          })
          .catch(() => {});
      }
      return json({ error: "job_failed" }, 500);
    }
  };
}
export { cloudConfig };
