import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  verifyDiscord,
  interactionsHandler,
  workerHandler,
  processJob,
} from "../src/cloud/handlers.js";
import { cloudConfig } from "../src/cloud/config.js";
import { canPost, alertMessage } from "../src/cloud/discord.js";
import type { CloudStore } from "../src/cloud/store.js";
import { watch, samplePayload, normalized } from "../src/fixtures.js";
import type { WatchConfig } from "../src/config/schema.js";
const config = () =>
  cloudConfig({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    WORKER_SECRET: "w".repeat(64),
    DISCORD_TOKEN: "fake-token",
    DISCORD_APPLICATION_ID: "123",
    DISCORD_GUILD_ID: "456",
  });
const hex = (array: ArrayBuffer) => Buffer.from(array).toString("hex");
test("Discord signatures reject tampering, missing signatures and replayed timestamps", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const pub = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const body = '{"type":1}';
  const time = String(Math.floor(Date.now() / 1000));
  const sig = hex(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(time + body),
    ),
  );
  assert.equal(await verifyDiscord(body, sig, time, pub), true);
  assert.equal(await verifyDiscord(body + " ", sig, time, pub), false);
  assert.equal(await verifyDiscord(body, null, time, pub), false);
  assert.equal(
    await verifyDiscord(body, sig, time, pub, Date.now() + 600000),
    false,
  );
  const response = await interactionsHandler(
    { ...config(), DISCORD_PUBLIC_KEY: pub },
    () => {},
  )(
    new Request("https://local", {
      method: "POST",
      body,
      headers: { "x-signature-ed25519": sig, "x-signature-timestamp": time },
    }),
  );
  assert.deepEqual(await response.json(), { type: 1 });
});
test("anonymous worker and unsigned Discord requests cannot access the database", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network request");
  });
  assert.equal(
    (
      await workerHandler(config())(
        new Request("https://local", { method: "POST" }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await interactionsHandler(config(), () => {})(
        new Request("https://local", { method: "POST", body: "{}" }),
      )
    ).status,
    401,
  );
});
test("channel permission checks honor role and user denies", () => {
  const required = 3072n;
  const guild = {
    id: "g",
    owner_id: "owner",
    roles: [
      { id: "g", permissions: "3072" },
      { id: "admin", permissions: "8" },
    ],
  };
  assert.equal(
    canPost(
      guild,
      { permission_overwrites: [] },
      { roles: [] },
      "user",
      required,
    ),
    true,
  );
  assert.equal(
    canPost(
      guild,
      {
        permission_overwrites: [
          { id: "user", type: 1, deny: "2048", allow: "0" },
        ],
      },
      { roles: [] },
      "user",
      required,
    ),
    false,
  );
  assert.equal(
    canPost(
      guild,
      {
        permission_overwrites: [
          { id: "user", type: 1, deny: "2048", allow: "0" },
        ],
      },
      { roles: ["admin"] },
      "user",
      required,
    ),
    true,
  );
});
test("cloud alert is a single-tier match with no pricing analysis", () => {
  const msg = alertMessage(samplePayload(), "sample");
  const e = msg.embeds![0];
  assert.match(e.title, /^MATCH · /);
  assert.equal(msg.components![0].components.length, 5);
  assert.deepEqual(
    msg.components![0].components.map((b: any) => b.label),
    ["Open listing", "Reviewed", "Save", "Dismiss", "Not relevant"],
  );
  assert.ok(e.fields.some((f: any) => f.value === "$50.00 + $5.00 shipping"));
  assert.ok(
    e.fields.some(
      (f: any) =>
        f.name === "Matched criteria" && f.value === "connectivity: wireless",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(e),
    /profit|resale|comparable|discount|all-in|max(imum)? bid|score/i,
  );
});
const area = { label: "Portland, OR", postalCode: null, radiusMiles: 25 };
const both: WatchConfig = {
  ...watch,
  sources: ["ebay", "facebook_marketplace"],
  location: area,
  deliveryModes: ["pickup"],
  intervalMinutes: 1440,
};
const worker = () =>
  cloudConfig({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    WORKER_SECRET: "w".repeat(64),
    DISCORD_TOKEN: "fake-token",
    DISCORD_APPLICATION_ID: "123",
    DISCORD_GUILD_ID: "456",
    CLOUD_MONITORING_ENABLED: "true",
    DRY_RUN: "false",
    EBAY_CLIENT_ID: "id",
    EBAY_CLIENT_SECRET: "secret",
    EBAY_POSTAL_CODE: "97201",
    GEMINI_API_KEY: "fake-key",
  });
const ebayItem = (id: string, title: string) => ({
  itemId: id,
  itemWebUrl: `https://www.ebay.com/itm/${id}`,
  title,
  price: { value: "50", currency: "USD" },
  buyingOptions: ["FIXED_PRICE"],
  conditionId: "3000",
  itemLocation: { country: "US" },
  seller: { username: "s", feedbackPercentage: "99", feedbackScore: 10 },
  shippingOptions: [{ shippingCost: { currency: "USD", value: "5" } }],
});
function services(t: any, extract = normalized) {
  const calls: string[] = [];
  const sent: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/identity/v1/oauth2/token"))
      return Response.json({ access_token: "t", expires_in: 7200 });
    if (u.includes("/item_summary/search"))
      return Response.json({
        itemSummaries: [
          ebayItem("1", "Acme wireless gaming mouse"),
          ebayItem("2", "Acme wireless gaming mouse (broken)"),
        ],
      });
    if (u.includes("/buy/browse/v1/item/"))
      return Response.json(ebayItem("1", "Acme wireless gaming mouse"));
    if (u.includes("generativelanguage.googleapis.com"))
      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: JSON.stringify(extract) }] },
          },
        ],
      });
    if (u.startsWith("https://discord.com/api/v10/channels/")) {
      sent.push(JSON.parse(init.body));
      return Response.json({ id: "message-1" });
    }
    throw new Error(`Unexpected request: ${u}`);
  });
  return { calls, sent };
}
function fakeDb() {
  const log = { enqueued: [] as any[], processed: [] as any[], alerts: 0 };
  const db = {
    watch: async () => ({ id: "w", active: true, revision: 1, config: both }),
    budget: async () => {},
    cooldown: async () => {},
    rows: async () => [],
    enqueue: async (rows: any[]) => log.enqueued.push(...rows),
    saveListing: async () => {},
    process: async (_w: string, _l: string, status: string, details: any) =>
      log.processed.push({ status, details }),
    normalized: async () => null,
    upsert: async () => {},
    rpc: async (name: string) => {
      assert.equal(name, "scout_reserve_alert");
      log.alerts++;
      return "alert-1";
    },
    update: async () => [],
  } as unknown as CloudStore;
  return { db, log };
}
test("both-source scans run the eBay leg and skip disabled Marketplace without a provider call", async (t) => {
  const { calls } = services(t);
  const { db, log } = fakeDb();
  await processJob(
    {
      id: "job",
      kind: "scan",
      payload: { watchId: "w", revision: 1 },
      lease_token: "l",
      attempts: 1,
    },
    worker(),
    db,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(
    log.enqueued.map((j) => j.payload.listing.id),
    ["1"],
  );
  assert.ok(calls.every((u) => u.includes("ebay.com")));
});
test("listing jobs alert matches once to the watch channel and keep non-matches silent", async (t) => {
  const job = {
    id: "job",
    kind: "listing" as const,
    payload: {
      watchId: "w",
      revision: 1,
      listing: { ...samplePayload().listing, id: "1" },
    },
    lease_token: "l",
    attempts: 1,
  };
  const matched = services(t);
  const a = fakeDb();
  await processJob(job, worker(), a.db, AbortSignal.timeout(5000));
  assert.deepEqual(
    a.log.processed.map((p) => p.status),
    ["matched"],
  );
  assert.equal(a.log.alerts, 1);
  assert.equal(matched.sent.length, 1);
  assert.match(matched.sent[0].embeds[0].title, /^MATCH/);
  assert.ok(
    matched.calls.some((u) => u.includes("/channels/demo-channel/messages")),
  );
  t.mock.restoreAll();
  const unrelated = services(t, { ...normalized, matchStatus: "not_match" });
  const b = fakeDb();
  await processJob(job, worker(), b.db, AbortSignal.timeout(5000));
  assert.deepEqual(b.log.processed, [
    {
      status: "rejected",
      details: { reason: "Not relevant to the search", warnings: [] },
    },
  ]);
  assert.equal(b.log.alerts, 0);
  assert.equal(unrelated.sent.length, 0);
});
test("real PostgreSQL migration, atomic confirmations, budgets, queue leases and service-only grants", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    await db.exec(
      readFileSync("supabase/migrations/202609170001_scout.sql", "utf8"),
    );
    const draft = (
      await db.query<{ id: string }>(
        "insert into scout_drafts(owner_id,guild_id,config,query) values($1,$2,$3,$4) returning id",
        ["alice", "g", JSON.stringify(watch), "mice"],
      )
    ).rows[0]!.id;
    await assert.rejects(
      db.query("select scout_confirm_draft($1,$2,$3)", [draft, "bob", "g"]),
    );
    const id = (
      await db.query<{ id: string }>(
        "select scout_confirm_draft($1,$2,$3) id",
        [draft, "alice", "g"],
      )
    ).rows[0]!.id;
    await assert.rejects(
      db.query("select scout_confirm_draft($1,$2,$3)", [draft, "alice", "g"]),
    );
    assert.equal(
      (await db.query("select * from scout_watches")).rows.length,
      1,
    );
    assert.equal(
      (await db.query<{ ok: boolean }>("select scout_take_budget('llm',1) ok"))
        .rows[0]!.ok,
      true,
    );
    assert.equal(
      (await db.query<{ ok: boolean }>("select scout_take_budget('llm',1) ok"))
        .rows[0]!.ok,
      false,
    );
    await db.query("select scout_enqueue_due()");
    await db.query("select scout_enqueue_due()");
    assert.equal((await db.query("select * from scout_jobs")).rows.length, 1);
    const job = (await db.query<any>("select * from scout_claim_job()"))
      .rows[0]!;
    assert.equal(
      (await db.query("select * from scout_claim_job()")).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select scout_finish_job($1,$2,$3) ok",
          [job.id, "00000000-0000-0000-0000-000000000000", "done"],
        )
      ).rows[0]!.ok,
      false,
    );
    await db.query("select scout_finish_job($1,$2,$3)", [
      job.id,
      job.lease_token,
      "done",
    ]);
    assert.deepEqual(
      (await db.query<any>("select payload from scout_jobs")).rows[0]!.payload,
      {},
    );
    await db.exec("set role anon;");
    await assert.rejects(db.query("select * from scout_watches"));
    await assert.rejects(db.query("select scout_enqueue_due()"));
    await db.exec("reset role;");
    await db.query("insert into scout_listings(id,data) values('l','{}')");
    const a = (
      await db.query<{ id: string }>(
        "select scout_reserve_alert($1,1,$2,$3) id",
        [id, "l", "{}"],
      )
    ).rows[0]!.id;
    assert.ok(a);
    assert.equal(
      (
        await db.query<{ id: null }>(
          "select scout_reserve_alert($1,1,$2,$3) id",
          [id, "l", "{}"],
        )
      ).rows[0]!.id,
      null,
    );
    await db.query("select scout_set_active($1,'alice','g',false)", [id]);
    await db.query("insert into scout_listings(id,data) values('l2','{}')");
    assert.equal(
      (
        await db.query<{ id: null }>(
          "select scout_reserve_alert($1,2,$2,$3) id",
          [id, "l2", "{}"],
        )
      ).rows[0]!.id,
      null,
    );
  } finally {
    await db.close();
  }
});
const marketplaceWorker = (extra: Record<string, string> = {}) =>
  cloudConfig({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    WORKER_SECRET: "w".repeat(64),
    DISCORD_TOKEN: "fake-token",
    DISCORD_APPLICATION_ID: "123",
    DISCORD_GUILD_ID: "456",
    CLOUD_MONITORING_ENABLED: "true",
    DRY_RUN: "true",
    FACEBOOK_MONITORING_ENABLED: "true",
    BRIGHT_DATA_API_KEY: "fake-bd-key",
    GEMINI_API_KEY: "fake-key",
    ...extra,
  });
const fbRecord = (
  id: string,
  listed: string,
  title = "Wireless gaming mouse",
) => ({
  url: `https://www.facebook.com/marketplace/item/${id}`,
  title,
  final_price: 40,
  currency: "USD",
  product_id: id,
  condition: "Used - Good",
  description: "Works great",
  location: "Beaverton, OR",
  country_code: null,
  profile_id: "999",
  listing_date: listed,
  is_sold: false,
});
// A small stateful stand-in for the Supabase tables the Marketplace flow touches.
function marketplaceDb(budgetLimit = Infinity) {
  const state = {
    runs: [] as any[],
    jobs: [] as any[],
    processed: new Map<string, string>(),
    used: 0,
  };
  const db = {
    watch: async () => ({ id: "w", active: true, revision: 1, config: both }),
    budget: async () => {},
    cooldown: async () => {},
    monthlyBudget: async (_s: string, amount: number) => {
      if (amount > 0 && state.used + amount > budgetLimit) return false;
      state.used += amount;
      return true;
    },
    rows: async (table: string, params: Record<string, string>) =>
      table === "scout_ingestion_runs"
        ? state.runs.filter(
            (r) =>
              params.query_key === `eq.${r.query_key}` &&
              ["running", "succeeded"].includes(r.status),
          )
        : [],
    insert: async (table: string, row: any) => {
      assert.equal(table, "scout_ingestion_runs");
      const saved = { id: `run${state.runs.length}`, ...row };
      state.runs.push(saved);
      return [saved];
    },
    update: async (table: string, params: any, fields: any) => {
      if (table === "scout_ingestion_runs")
        Object.assign(
          state.runs.find((r) => `eq.${r.id}` === params.id),
          fields,
        );
      return [];
    },
    enqueue: async (rows: any[]) => state.jobs.push(...rows),
    seen: async (_w: string, ids: string[]) =>
      new Set(ids.filter((id) => state.processed.has(id))),
    saveListing: async () => {},
    process: async (_w: string, l: string, status: string) =>
      state.processed.set(l, status),
  } as unknown as CloudStore;
  return { db, state };
}
function brightData(t: any, snapshots: Record<string, any[]>) {
  const triggers: any[] = [];
  let progress = "running";
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.brightdata.com")
      throw new Error(`Unexpected request: ${u}`);
    if (u.pathname === "/datasets/v3/trigger") {
      triggers.push({
        limit: u.searchParams.get("limit_per_input"),
        input: JSON.parse(init.body).input[0],
      });
      return Response.json({ snapshot_id: `sd_${triggers.length}` });
    }
    if (u.pathname.startsWith("/datasets/v3/progress/"))
      return Response.json({ status: progress });
    const id = u.pathname.split("/").pop()!;
    return Response.json(snapshots[id] ?? []);
  });
  return {
    triggers,
    ready: () => {
      progress = "ready";
    },
  };
}
const job = (kind: any, payload: any, id = "job") => ({
  id,
  kind,
  payload: { watchId: "w", revision: 1, ...payload },
  lease_token: "l",
  attempts: 1,
});
test("Marketplace polling: first search shows current listings, later hourly polls stay small and skip repeats", async (t) => {
  const bd = brightData(t, {
    sd_1: [
      fbRecord("1", "2026-09-10T00:00:00.000Z"),
      fbRecord("2", "2026-09-27T00:00:00.000Z"),
      fbRecord("3", "2026-09-27T12:00:00.000Z", "Mouse, broken wheel"),
    ],
    sd_2: [
      fbRecord("2", "2026-09-27T00:00:00.000Z"),
      fbRecord("4", "2026-09-28T09:00:00.000Z"),
    ],
  });
  const { db, state } = marketplaceDb();
  const c = marketplaceWorker();
  const signal = AbortSignal.timeout(5000);
  // eBay has no credentials yet: its leg is skipped, not a failure.
  await processJob(job("scan", {}), c, db, signal);
  assert.deepEqual(bd.triggers, [
    {
      limit: "10",
      input: {
        keyword: "wireless gaming mouse",
        city: "Portland, Oregon",
        radius: 25,
        date_listed: "",
      },
    },
  ]);
  assert.equal(state.used, 10);
  const [first] = state.jobs.splice(0);
  assert.equal(first.kind, "snapshot");
  assert.ok(Date.parse(first.available_at) > Date.now());
  // Still running: re-check later without re-triggering (no new charge).
  await processJob(job("snapshot", first.payload), c, db, signal);
  const [again] = state.jobs.splice(0);
  assert.equal(again.dedupe_key, "snapshot:sd_1:1");
  assert.equal(bd.triggers.length, 1);
  bd.ready();
  await processJob(job("snapshot", again.payload), c, db, signal);
  // 3 records returned: 7 unused reserved records are refunded.
  assert.equal(state.used, 3);
  assert.equal(
    state.processed.get("facebook_marketplace:brightdata:3"),
    "filtered",
  );
  // Newest first; older listings are kept on the first search.
  assert.deepEqual(
    state.jobs.splice(0).map((j) => j.payload.listing.id),
    ["facebook_marketplace:brightdata:2", "facebook_marketplace:brightdata:1"],
  );
  assert.equal(state.runs[0].status, "succeeded");
  assert.equal(state.runs[0].records_received, 3);
  state.processed.set("facebook_marketplace:brightdata:2", "matched");
  state.processed.set("facebook_marketplace:brightdata:1", "rejected");
  // Next hourly poll: 2 recent records; the already-seen one is not re-processed.
  await processJob(job("scan", {}, "job2"), c, db, signal);
  assert.deepEqual(bd.triggers[1], {
    limit: "2",
    input: {
      keyword: "wireless gaming mouse",
      city: "Portland, Oregon",
      radius: 25,
      date_listed: "Last 24 hours",
    },
  });
  const [second] = state.jobs.splice(0);
  await processJob(job("snapshot", second.payload), c, db, signal);
  assert.deepEqual(
    state.jobs.map((j) => j.payload.listing.id),
    ["facebook_marketplace:brightdata:4"],
  );
  assert.equal(state.used, 5);
});
test("Marketplace polls stop at the monthly record budget without calling Bright Data", async (t) => {
  const bd = brightData(t, {});
  const { db, state } = marketplaceDb(9);
  await processJob(
    job("scan", {}),
    marketplaceWorker(),
    db,
    AbortSignal.timeout(5000),
  );
  assert.equal(bd.triggers.length, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.used, 0);
});
test("a failed Marketplace trigger refunds its reserved records", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("", { status: 400 }),
  );
  const { db, state } = marketplaceDb();
  await assert.rejects(
    processJob(
      job("scan", {}),
      marketplaceWorker(),
      db,
      AbortSignal.timeout(5000),
    ),
  );
  assert.equal(state.used, 0);
  assert.equal(state.runs.length, 0);
});
test("Marketplace city names are normalized so Facebook recognizes them", async () => {
  const { marketplaceCity, stateOf } =
    await import("../src/config/preferences.js");
  const at = (label: string, city: string | null = null) =>
    marketplaceCity({ label, postalCode: null, radiusMiles: 5, city });
  assert.equal(at("campbell, ca"), "Campbell, CA");
  assert.equal(at("SAN JOSE, ca"), "San Jose, CA");
  assert.equal(at("97201", "portland, or"), "Portland, OR");
  assert.equal(at("97201"), null);
  assert.equal(stateOf("Beaverton, OR"), "OR");
  assert.equal(stateOf("Portland"), null);
});
test("a batch entirely outside the watch's state is treated as an unrecognized city", async (t) => {
  const bd = brightData(t, {
    sd_1: [
      { ...fbRecord("7", "2026-09-27T00:00:00.000Z"), location: "Norfolk, VA" },
      {
        ...fbRecord("8", "2026-09-26T00:00:00.000Z"),
        location: "Portsmouth, VA",
      },
    ],
  });
  bd.ready();
  const { db, state } = marketplaceDb();
  const c = marketplaceWorker();
  const signal = AbortSignal.timeout(5000);
  await processJob(job("scan", {}), c, db, signal);
  assert.equal(bd.triggers[0].input.city, "Portland, Oregon");
  const [snap] = state.jobs.splice(0);
  await processJob(job("snapshot", snap.payload), c, db, signal);
  assert.equal(state.jobs.length, 0);
  assert.equal(
    state.processed.get("facebook_marketplace:brightdata:7"),
    "filtered",
  );
  // A batch with at least one in-state listing is trusted (cross-border metros).
  const bd2 = brightData(t, {
    sd_1: [
      {
        ...fbRecord("9", "2026-09-27T00:00:00.000Z"),
        location: "Vancouver, WA",
      },
      fbRecord("10", "2026-09-26T00:00:00.000Z"),
    ],
  });
  bd2.ready();
  const fresh = marketplaceDb();
  await processJob(job("scan", {}), c, fresh.db, signal);
  const [snap2] = fresh.state.jobs.splice(0);
  await processJob(job("snapshot", snap2.payload), c, fresh.db, signal);
  assert.equal(fresh.state.jobs.length, 2);
});
test("queued listings are still evaluated after the watch is edited", async (t) => {
  const matched = services(t);
  const a = fakeDb();
  await processJob(
    {
      id: "job",
      kind: "listing",
      payload: {
        watchId: "w",
        revision: 0,
        listing: { ...samplePayload().listing, id: "1" },
      },
      lease_token: "l",
      attempts: 1,
    },
    worker(),
    a.db,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(
    a.log.processed.map((p) => p.status),
    ["matched"],
  );
  assert.equal(matched.sent.length, 1);
});
test("Bright Data receives full state names; unknown or foreign regions pass through", async () => {
  const { providerCity } = await import("../src/connectors/brightdata.js");
  const at = (label: string) =>
    providerCity({ label, postalCode: null, radiusMiles: 5, city: null });
  assert.equal(at("campbell, ca"), "Campbell, California");
  assert.equal(at("Washington, DC"), "Washington, District of Columbia");
  assert.equal(at("Springfield"), "Springfield");
  assert.equal(at("97201"), null);
});
