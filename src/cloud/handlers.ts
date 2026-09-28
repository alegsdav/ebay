import { cloudConfig, type CloudConfig } from "./config.js";
import { CloudStore, type Job } from "./store.js";
import { CloudCommands, authorized } from "./commands.js";
import {
  actor,
  DiscordHttp,
  alertMessage,
  type Interaction,
} from "./discord.js";
import { LlmClient, PROMPT_VERSION } from "../llm/client.js";
import { EbaySource } from "../connectors/ebay.js";
import { Listing } from "../config/schema.js";
import { basicReject } from "../filters/matches.js";
import { evaluate } from "../pricing/score.js";
import { HttpError } from "../connectors/http.js";
import { log, errorKind } from "../logging.js";
import {
  redact,
  ManualInput,
  marketplaceIdentity,
} from "../connectors/manual.js";
import { validateScheduledWatch } from "../connectors/source.js";
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
      if (
        i.data?.name === "listing" &&
        i.data.options?.[0]?.name === "evaluate"
      ) {
        ManualInput.parse(
          Object.fromEntries(
            (i.data.options[0].options ?? [])
              .filter((o: any) => o.name !== "watch")
              .map((o: any) => [o.name, o.value]),
          ),
        );
        for (const option of i.data.options[0].options ?? []) {
          if (
            ["title", "notes", "location"].includes(option.name) &&
            typeof option.value === "string"
          )
            option.value = redact(option.value);
          if (option.name === "url" && typeof option.value === "string") {
            option.value = marketplaceIdentity(option.value).url;
          }
        }
      }
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
  if (!w || !w.active || w.revision !== job.payload.revision) return;
  validateScheduledWatch(w.config);
  const source = new EbaySource(
    { ...c.env, MAX_PAGES_PER_WATCH: 1 },
    () => db.budget("ebay", c.env.EBAY_MAX_CALLS_PER_DAY),
    signal,
  );
  if (job.kind === "scan") {
    const candidates = new Map<string, Listing>();
    for await (const l of source.search(w.config)) {
      if (!basicReject(l, w.config)) candidates.set(l.id, l);
      if (candidates.size >= c.CLOUD_ITEMS_PER_WATCH) break;
    }
    const old = await db.rows("scout_processing", {
      watch_id: `eq.${w.id}`,
      status: "in.(silent,possible,needs_processing)",
      order: "updated_at.asc",
      limit: "10",
      select: "listing_id,scout_listings(data)",
    });
    for (const row of old) {
      const l = Listing.parse(row.scout_listings.data);
      if (!l.endTime || Date.parse(l.endTime) > Date.now())
        candidates.set(l.id, l);
    }
    await db.enqueue(
      [...candidates.values()].map((l) => ({
        dedupe_key: `listing:${job.id}:${l.id}`,
        kind: "listing",
        payload: { watchId: w.id, revision: w.revision, listing: l },
      })),
    );
    log("cloud_scan_enqueued", {
      watchId: w.id,
      candidates: candidates.size,
      cap: c.CLOUD_ITEMS_PER_WATCH,
    });
    return;
  }
  let listing = Listing.parse(job.payload.listing);
  await db.saveListing(listing);
  try {
    // All queued candidates are refreshed; never alert using the queued price snapshot.
    listing = await source.detail(listing);
    await db.saveListing(listing);
    const reject = basicReject(listing, w.config);
    if (reject) {
      await db.process(w.id, listing.id, "filtered", { reason: reject });
      return;
    }
    const model = llm();
    const hash = await digest({
      title: listing.title,
      description: listing.description,
      specifics: listing.specifics,
      condition: listing.condition,
      model: model.model,
      prompt: PROMPT_VERSION,
    });
    let n = await db.normalized(listing.id, w.config.category, hash);
    if (!n) {
      n = await model.normalize(listing, w.config);
      if (n.confidence >= 0.65)
        await db.upsert(
          "scout_normalized",
          {
            listing_id: listing.id,
            category: w.config.category,
            hash,
            data: n,
            model: model.model,
            prompt_version: PROMPT_VERSION,
            created_at: new Date().toISOString(),
          },
          "listing_id,category",
        );
    }
    const result = evaluate(
      listing,
      n,
      w.config,
      await db.comparables(w.config.category, w.config.lookbackDays),
    );
    // Full comparable evidence belongs only in emitted alerts, avoiding repeated large DB snapshots.
    await db.process(w.id, listing.id, result.tier, {
      reasons: result.reasons,
      warnings: result.warnings,
      metrics: result.metrics,
    });
    const channel =
      result.tier === "strong"
        ? w.config.channelId
        : result.tier === "possible"
          ? w.config.possibleChannelId
          : null;
    if (!channel) return;
    const payload = {
      listing,
      normalized: n,
      evaluation: result,
      config: w.config,
    };
    if (c.env.DRY_RUN) {
      log("cloud_dry_run_alert", {
        watchId: w.id,
        listingId: listing.id,
        metrics: result.metrics,
      });
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
        channel,
        alertMessage(payload, id),
        id,
      );
      await db.update(
        "scout_alerts",
        { id: `eq.${id}` },
        { status: "sent", message_id: message.id },
      );
    } catch (error) {
      await db.update(
        "scout_alerts",
        { id: `eq.${id}` },
        { status: "delivery_unknown" },
      );
      log("cloud_delivery_unknown", { alertId: id, error: errorKind(error) });
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
