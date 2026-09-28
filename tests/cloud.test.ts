import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  verifyDiscord,
  interactionsHandler,
  workerHandler,
} from "../src/cloud/handlers.js";
import { cloudConfig } from "../src/cloud/config.js";
import { canPost, alertMessage } from "../src/cloud/discord.js";
import { watch, samplePayload } from "../src/fixtures.js";
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
test("cloud alert preserves arithmetic, evidence and component limits", () => {
  const msg = alertMessage(samplePayload(), "sample");
  assert.equal(msg.components![0].components.length, 5);
  assert.ok(msg.embeds![0].fields.some((f: any) => f.value.includes("$59.40")));
  assert.ok(msg.embeds![0].fields.some((f: any) => f.name === "Sale evidence"));
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
