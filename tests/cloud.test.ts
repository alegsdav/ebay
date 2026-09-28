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
