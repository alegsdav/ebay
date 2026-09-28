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
import { BrightDataSource } from "../connectors/brightdata.js";
import { Listing, type WatchConfig } from "../config/schema.js";
import { basicReject } from "../filters/matches.js";
import { evaluateMatch, minExtractionConfidence } from "../filters/evaluate.js";
import { HttpError } from "../connectors/http.js";
import { log, errorKind } from "../logging.js";
import { scheduledSources } from "../connectors/source.js";
import { marketplaceCity, stateOf } from "../config/preferences.js";
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
      resolveCity: (zip: string) => llm().resolveCity(zip),
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
  // Only scans are tied to a revision. Snapshot records are already paid for and
  // listing jobs are evaluated against the current config, so neither is dropped
  // (and later re-billed) just because the watch was edited, paused or resumed.
  if (
    !w ||
    !w.active ||
    (job.kind === "scan" && w.revision !== job.payload.revision)
  )
    return;
  const sources = sourceConnectors(
    w.config,
    c,
    db,
    signal,
    job.kind === "scan",
  );
  if (job.kind === "scan") return scan(job, w, sources, c, db);
  if (job.kind === "snapshot") return collectSnapshot(job, w, sources, c, db);
  let listing = Listing.parse(job.payload.listing);
  if (!sources[listing.source === "ebay" ? "ebay" : "facebook"]) {
    log("cloud_listing_skipped", {
      watchId: w.id,
      source: listing.source,
      reason: "source_not_scanned",
    });
    return;
  }
  await db.saveListing(listing);
  try {
    // eBay candidates are refreshed; Marketplace records arrive fresh from their snapshot.
    if (listing.source === "ebay") {
      listing = await sources.ebay!.detail(listing);
      await db.saveListing(listing);
    }
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
      return;
    }
    await db.process(w.id, listing.id, "matched", {
      warnings: match.warnings,
    });
    const payload = { listing, normalized: n, match, config: w.config };
    if (c.env.DRY_RUN) {
      log("cloud_dry_run_alert", {
        watchId: w.id,
        listingId: listing.id,
        source: listing.source,
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
        w.config.channelId,
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
type Sources = ReturnType<typeof sourceConnectors>;
type ActiveWatch = NonNullable<Awaited<ReturnType<CloudStore["watch"]>>>;
const recordBudget = "brightdata_records";
// Each source is scanned independently: one failing or disabled leg never
// blocks the others, and a retry re-runs only when every leg failed.
async function scan(
  job: Job,
  w: ActiveWatch,
  sources: Sources,
  c: CloudConfig,
  db: CloudStore,
) {
  const candidates = new Map<string, Listing>();
  const failures: unknown[] = [];
  const legs = [
    sources.ebay &&
      (async () => {
        let found = 0;
        for await (const l of sources.ebay!.search(w.config)) {
          if (!basicReject(l, w.config) && !candidates.has(l.id)) {
            candidates.set(l.id, l);
            found++;
          }
          if (found >= c.CLOUD_ITEMS_PER_WATCH) break;
        }
      }),
    sources.facebook && (() => startSnapshot(w, sources.facebook!, c, db)),
  ].filter((leg) => !!leg);
  for (const leg of legs)
    try {
      await leg();
    } catch (error) {
      failures.push(error);
      if (error instanceof HttpError && error.status === 429)
        await db.cooldown(error.service, error.retryAt).catch(() => {});
      log("cloud_source_failure", { watchId: w.id, error: errorKind(error) });
    }
  if (legs.length && failures.length === legs.length) throw failures[0];
  const old = await db.rows("scout_processing", {
    watch_id: `eq.${w.id}`,
    status: "eq.needs_processing",
    order: "updated_at.asc",
    limit: "10",
    select: "listing_id,scout_listings(data)",
  });
  for (const row of old) {
    const l = Listing.parse(row.scout_listings.data);
    if (
      sources[l.source === "ebay" ? "ebay" : "facebook"] &&
      (!l.endTime || Date.parse(l.endTime) > Date.now())
    )
      candidates.set(l.id, l);
  }
  await db.enqueue(
    listingJobs(`listing:${job.id}`, w, [...candidates.values()]),
  );
  log("cloud_scan_enqueued", {
    watchId: w.id,
    candidates: candidates.size,
    cap: c.CLOUD_ITEMS_PER_WATCH,
  });
}
function listingJobs(prefix: string, w: ActiveWatch, listings: Listing[]) {
  // Stagger availability so newer listings are processed (and alerted) first.
  const now = Date.now();
  return listings.map((l, i) => ({
    dedupe_key: `${prefix}:${l.id}`,
    kind: "listing" as const,
    payload: { watchId: w.id, revision: w.revision, listing: l },
    available_at: new Date(now + i * 1000).toISOString(),
  }));
}
// The first search for a watch's keywords and city returns current listings
// (older ones included); later hourly polls ask only for a few recent ones.
async function startSnapshot(
  w: ActiveWatch,
  facebook: BrightDataSource,
  c: CloudConfig,
  db: CloudStore,
) {
  const queryKey = await digest({
    searchTerms: w.config.searchTerms,
    city: w.config.location && marketplaceCity(w.config.location),
    radius: w.config.location?.radiusMiles,
  });
  const initial = !(
    await db.rows("scout_ingestion_runs", {
      watch_id: `eq.${w.id}`,
      query_key: `eq.${queryKey}`,
      status: "in.(running,succeeded)",
      select: "id",
      limit: "1",
    })
  ).length;
  const limit = initial
    ? c.env.BRIGHT_DATA_INITIAL_RECORDS
    : c.env.BRIGHT_DATA_POLL_RECORDS;
  const cap = c.env.BRIGHT_DATA_MAX_RECORDS_PER_MONTH;
  if (!(await db.monthlyBudget(recordBudget, limit, cap))) {
    log("brightdata_budget_exhausted", { watchId: w.id, limit, cap });
    return;
  }
  let snapshotId: string;
  try {
    snapshotId = await facebook.trigger(w.config, {
      limit,
      recentOnly: !initial,
    });
  } catch (error) {
    await db.monthlyBudget(recordBudget, -limit, cap).catch(() => {});
    throw error;
  }
  const [run] = await db.insert("scout_ingestion_runs", {
    watch_id: w.id,
    provider_request_id: snapshotId,
    query_key: queryKey,
    status: "running",
    pages_requested: 1,
    cost_units: limit,
  });
  await db.enqueue([
    snapshotJob(w, {
      snapshotId,
      runId: run?.id ?? null,
      reserved: limit,
      polls: 0,
    }),
  ]);
  log("brightdata_triggered", { watchId: w.id, limit, initial });
}
function snapshotJob(
  w: ActiveWatch,
  p: {
    snapshotId: string;
    runId: string | null;
    reserved: number;
    polls: number;
  },
) {
  return {
    dedupe_key: `snapshot:${p.snapshotId}:${p.polls}`,
    kind: "snapshot" as const,
    payload: { watchId: w.id, revision: w.revision, ...p },
    available_at: new Date(Date.now() + 60000).toISOString(),
  };
}
async function collectSnapshot(
  job: Job,
  w: ActiveWatch,
  sources: Sources,
  c: CloudConfig,
  db: CloudStore,
) {
  const p = job.payload as {
    snapshotId: string;
    runId: string | null;
    reserved: number;
    polls: number;
  };
  const cap = c.env.BRIGHT_DATA_MAX_RECORDS_PER_MONTH;
  const finish = (fields: Record<string, unknown>) =>
    p.runId
      ? db.update(
          "scout_ingestion_runs",
          { id: `eq.${p.runId}` },
          { finished_at: new Date().toISOString(), ...fields },
        )
      : Promise.resolve();
  if (!sources.facebook) {
    log("cloud_snapshot_skipped", { watchId: w.id, reason: "source_disabled" });
    return;
  }
  const status = await sources.facebook.progress(p.snapshotId);
  if (status === "starting" || status === "running") {
    if (p.polls >= 20) {
      await finish({ status: "failed", error_kind: "snapshot_timeout" });
      log("brightdata_snapshot_timeout", { watchId: w.id });
      return;
    }
    await db.enqueue([snapshotJob(w, { ...p, polls: p.polls + 1 })]);
    return;
  }
  if (status !== "ready") {
    await db.monthlyBudget(recordBudget, -p.reserved, cap).catch(() => {});
    await finish({ status: "failed", error_kind: `snapshot_${status}` });
    log("brightdata_snapshot_failed", { watchId: w.id, status });
    return;
  }
  const result = await sources.facebook.download(p.snapshotId);
  const unused = p.reserved - result.received;
  if (unused > 0) await db.monthlyBudget(recordBudget, -unused, cap);
  // Already-seen listings are billed again by Bright Data, but never re-processed.
  const seen = await db.seen(
    w.id,
    result.listings.map((l) => l.id),
  );
  const fresh = result.listings
    .filter((l) => !seen.has(l.id))
    .sort(
      (a, b) =>
        (b.listedAt ? Date.parse(b.listedAt) : 0) -
        (a.listedAt ? Date.parse(a.listedAt) : 0),
    );
  // If the city was not recognized, Facebook falls back to the provider's own
  // location: a batch with no listing in the watch's state is not trusted.
  const wanted = stateOf(
    w.config.location && marketplaceCity(w.config.location),
  );
  const states = fresh
    .map((l) => stateOf(l.provenance?.locationLabel))
    .filter((s) => s !== null);
  const misplaced = !!wanted && states.length > 0 && !states.includes(wanted);
  if (misplaced)
    log("brightdata_location_mismatch", {
      watchId: w.id,
      wanted,
      received: [...new Set(states)],
    });
  const accepted: Listing[] = [];
  for (const l of fresh) {
    const reason = misplaced
      ? "Outside search area (city not recognized by Facebook)"
      : basicReject(l, w.config);
    if (!reason) {
      accepted.push(l);
      continue;
    }
    await db.saveListing(l);
    await db.process(w.id, l.id, "filtered", { reason });
  }
  await db.enqueue(listingJobs(`listing:${p.snapshotId}`, w, accepted));
  await finish({
    status: "succeeded",
    records_received: result.received,
    records_accepted: accepted.length,
    cost_units: result.received,
  });
  log("brightdata_collected", {
    watchId: w.id,
    received: result.received,
    errors: result.errors,
    rejected: result.rejected,
    repeats: result.listings.length - fresh.length,
    queued: accepted.length,
  });
}
// Connectors for the sources this watch scans now; disabled or unconfigured legs
// are logged and skipped.
function sourceConnectors(
  w: WatchConfig,
  c: CloudConfig,
  db: CloudStore,
  signal: AbortSignal,
  logSkips = true,
) {
  const plan = scheduledSources(w, {
    ebay: !!(
      c.env.EBAY_CLIENT_ID &&
      c.env.EBAY_CLIENT_SECRET &&
      c.env.EBAY_POSTAL_CODE
    ),
    facebook: c.env.FACEBOOK_MONITORING_ENABLED && !!c.env.BRIGHT_DATA_API_KEY,
  });
  if (logSkips)
    for (const skip of plan.skipped) log("cloud_source_skipped", skip);
  return {
    ebay: plan.scan.includes("ebay")
      ? new EbaySource(
          { ...c.env, MAX_PAGES_PER_WATCH: 1 },
          () => db.budget("ebay", c.env.EBAY_MAX_CALLS_PER_DAY),
          signal,
        )
      : undefined,
    facebook: plan.scan.includes("facebook_marketplace")
      ? new BrightDataSource(
          c.env,
          () => db.budget("brightdata", c.env.BRIGHT_DATA_MAX_CALLS_PER_DAY),
          signal,
        )
      : undefined,
  };
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
