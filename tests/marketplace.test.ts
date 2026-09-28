import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  manualDraft,
  evaluateManual,
  redact,
  marketplaceIdentity,
} from "../src/connectors/manual.js";
import {
  assertSourceAccess,
  validateScheduledWatch,
} from "../src/connectors/source.js";
import {
  watch,
  normalized,
  comparableFixtures,
  parsed,
} from "../src/fixtures.js";
import { Comparable, Listing } from "../src/config/schema.js";
import { evaluate } from "../src/pricing/score.js";
import { Store } from "../src/database/store.js";
import { resolveWatch } from "../src/config/categories.js";
import { getEnv } from "../src/config/env.js";
import { CloudCommands } from "../src/cloud/commands.js";
import { CloudStore } from "../src/cloud/store.js";
import { DiscordHttp } from "../src/cloud/discord.js";
import { cloudConfig } from "../src/cloud/config.js";
const input = {
  source: "facebook",
  url: "https://www.facebook.com/marketplace/item/123/?tracking=private",
  title: "Acme Feather 2",
  price: 50,
  condition: "open_box",
  location: "Santa Cruz, CA",
  travel: 10,
};
const llm = {
  model: "test",
  parseWatch: async () => parsed,
  normalize: async () => normalized,
};

test("manual listing canonicalizes identity, redacts evidence and never fetches Facebook", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("No network permitted");
  });
  const draft = await manualDraft(
    {
      ...input,
      notes:
        "Call 831-555-1234 or seller@example.com at 123 West Main Street, Santa Cruz",
    },
    watch,
  );
  assert.equal(draft.listing.id, "facebook_marketplace:manual:123");
  assert.equal(
    draft.listing.url,
    "https://www.facebook.com/marketplace/item/123/",
  );
  assert.doesNotMatch(
    JSON.stringify(draft),
    /831-555-1234|seller@example|123 West Main|tracking/,
  );
  assert.equal(draft.listing.provenance!.evidenceHash.length, 64);
  const result = await evaluateManual(draft, llm, comparableFixtures());
  assert.match(result.content!, /Tier 2/);
  assert.ok(result.files?.[0]?.content.includes("promptVersion"));
  assert.equal(result.components!.length, 0);
});

test("manual input rejects unsafe URLs, precise location, malformed prices and source mismatch", async () => {
  for (const url of [
    "https://evil.facebook.com/marketplace/item/1",
    "https://facebook.com.evil.org/marketplace/item/1",
    "http://facebook.com/marketplace/item/1",
    "https://user:pass@facebook.com/marketplace/item/1",
    "https://facebook.com/profile.php?id=1",
    "https://facebook.com:444/marketplace/item/1",
  ])
    assert.throws(() => marketplaceIdentity(url));
  for (const change of [
    { price: -1 },
    { price: NaN },
    { location: "123 West Main Street" },
    { location: "36.9741, -122.0308" },
  ])
    await assert.rejects(manualDraft({ ...input, ...change }, watch));
  const draft = await manualDraft(input, watch);
  assert.equal(
    Listing.safeParse({ ...draft.listing, source: "ebay" }).success,
    false,
  );
  assert.match(redact("a@b.com 8315551234"), /removed/);
});

test("pickup arithmetic accounts for travel without inflating tax or inventing seller evidence", async () => {
  const { listing } = await manualDraft(input, watch);
  const result = evaluate(listing, normalized, watch, comparableFixtures());
  assert.equal(result.tier, "possible");
  assert.equal(result.metrics!.allIn, 69.1); // $50 + $4 tax + $10 travel + $5.10 reserve
  assert.equal(result.metrics!.profit, 10.3);
  assert.equal(result.metrics!.travelCost, 10);
  assert.equal(result.metrics!.maxBid, 59.54);
  assert.equal(listing.sellerPercent, null);
  const expensive = {
    ...listing,
    provenance: { ...listing.provenance!, travelCost: 100 },
  };
  assert.equal(
    evaluate(expensive, normalized, watch, comparableFixtures()).tier,
    "silent",
  );
});

test("missing condition or sold evidence stays Tier 3; asking prices cannot be imported", async () => {
  const draft = await manualDraft(input, watch);
  const message = await evaluateManual(draft, llm, []);
  assert.match(message.content!, /Tier 3/);
  assert.match(message.embeds![0].title, /INSUFFICIENT/);
  assert.equal(
    evaluate(
      { ...draft.listing, condition: "unknown" },
      { ...normalized, condition: "unknown" },
      watch,
      comparableFixtures(),
    ).tier,
    "silent",
  );
  const sale = comparableFixtures()[0]!;
  assert.equal(
    Comparable.safeParse({ ...sale, source: "facebook_marketplace" }).success,
    false,
  );
  assert.equal(
    Comparable.safeParse({ ...sale, sourceUrl: input.url }).success,
    false,
  );
  assert.equal(
    evaluate(
      draft.listing,
      normalized,
      watch,
      comparableFixtures().map((c) => ({
        ...c,
        source: "facebook_marketplace",
      })),
    ).metrics,
    null,
  );
});

test("source access and scheduling fail closed; no enabled-provider flag is accepted", () => {
  assertSourceAccess("ebay", "ebay", "authorized_api", true);
  assertSourceAccess("facebook_marketplace", "manual", "user_submitted", true);
  for (const mode of ["scrape", "licensed_provider", "authorized_api"])
    assert.throws(() =>
      assertSourceAccess("facebook_marketplace", "unreviewed", mode, true),
    );
  assert.throws(() =>
    assertSourceAccess("ebay", "ebay", "authorized_api", false),
  );
  assert.throws(() =>
    validateScheduledWatch({ ...watch, sources: ["facebook_marketplace"] }),
  );
  assert.throws(
    () =>
      resolveWatch(
        { ...parsed, sources: ["facebook_marketplace"] },
        "Facebook mice",
        "c",
        watch.fees,
      ),
    /location|city/,
  );
  assert.equal(getEnv({}).FACEBOOK_MONITORING_ENABLED, false);
  assert.throws(() => getEnv({ FACEBOOK_MONITORING_ENABLED: "true" }));
});

test("local previews enforce owner, guild, expiry and single-use confirmation; results are private", async () => {
  const db = new Store(":memory:");
  try {
    const draft = await manualDraft(input, watch);
    const id = db.createSubmission("alice", "guild", draft);
    assert.throws(() => db.consumeSubmission(id, "bob", "guild"));
    assert.throws(() => db.consumeSubmission(id, "alice", "other"));
    assert.deepEqual(db.consumeSubmission(id, "alice", "guild"), draft);
    assert.throws(() => db.consumeSubmission(id, "alice", "guild"));
    const expired = db.createSubmission("alice", "guild", draft);
    db.db
      .prepare("UPDATE manual_submissions SET expires_at=0 WHERE id=?")
      .run(expired);
    assert.throws(() => db.consumeSubmission(expired, "alice", "guild"));
    db.saveEvaluation(id, "alice", "guild", { content: "evidence" });
    assert.equal(db.manualEvaluation(id, "bob", "guild"), null);
    assert.equal(db.manualEvaluation(id, "alice", "guild").content, "evidence");
  } finally {
    db.close();
  }
});

test("cloud evaluation waits for confirmation and verifies ownership before normalization", async () => {
  let calls = 0;
  let saved: any;
  const db = {
    watch: async (_id: string, owner: string) =>
      owner === "alice" ? { config: watch } : null,
    createSubmission: async (
      _owner: string,
      _guild: string,
      _interaction: string,
      data: unknown,
    ) => {
      saved = data;
      return { id: "preview", data };
    },
    rpc: async (_name: string, args: any) => {
      if (args.p_owner !== "alice" || !saved)
        throw new Error("Not owned or consumed");
      const result = saved;
      saved = null;
      return result;
    },
    comparables: async () => comparableFixtures(),
    insert: async () => [],
  } as unknown as CloudStore;
  const config = cloudConfig({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    WORKER_SECRET: "w".repeat(64),
    DISCORD_TOKEN: "fake",
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild",
  });
  const commands = new CloudCommands(
    db,
    {} as DiscordHttp,
    {
      ...llm,
      normalize: async () => {
        calls++;
        return normalized;
      },
    },
    config,
  );
  const base = {
    id: "interaction",
    application_id: "app",
    guild_id: "guild",
    token: "token",
    member: { user: { id: "alice" } },
  };
  const result = await commands.run({
    ...base,
    type: 2,
    data: {
      name: "listing",
      options: [
        {
          name: "evaluate",
          type: 1,
          options: Object.entries({ ...input, watch: "watch" }).map(
            ([name, value]) => ({ name, value }),
          ),
        },
      ],
    },
  });
  assert.equal(calls, 0);
  assert.equal(
    result.components![0].components[0].custom_id,
    "manual:confirm:preview",
  );
  await assert.rejects(
    commands.run({
      ...base,
      member: { user: { id: "bob" } },
      type: 3,
      data: { custom_id: "manual:confirm:preview" },
    }),
  );
  await commands.run({
    ...base,
    type: 3,
    data: { custom_id: "manual:confirm:preview" },
  });
  assert.equal(calls, 1);
  await assert.rejects(
    commands.run({
      ...base,
      type: 3,
      data: { custom_id: "manual:confirm:preview" },
    }),
  );
});

test("new PostgreSQL migration enforces confirmations, zero budgets, kill switch, cleanup and grants", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    for (const file of [
      "202609170001_scout.sql",
      "202609240001_classifieds.sql",
    ])
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    const id = (
      await db.query<{ id: string }>(
        "insert into scout_submissions(owner_id,guild_id,interaction_id,data) values ('alice','g','i','{\"test\":true}') returning id",
      )
    ).rows[0]!.id;
    await assert.rejects(
      db.query("select scout_consume_submission($1,'bob','g')", [id]),
    );
    await db.query("select scout_consume_submission($1,'alice','g')", [id]);
    await assert.rejects(
      db.query("select scout_consume_submission($1,'alice','g')", [id]),
    );
    const config = (
      await db.query<{ id: string }>(
        "insert into scout_source_configs(source,provider,access_mode) values ('facebook_marketplace','test','licensed_provider') returning id",
      )
    ).rows[0]!.id;
    const budget = async () =>
      (
        await db.query<{ ok: boolean }>(
          "select scout_take_source_budget($1,1) ok",
          [config],
        )
      ).rows[0]!.ok;
    assert.equal(await budget(), false);
    await db.query(
      "update scout_source_configs set enabled=true, terms_reviewed_at=now(), terms_reference='test only', daily_request_limit=2,daily_cost_limit=1 where id=$1",
      [config],
    );
    assert.equal(await budget(), true);
    assert.equal(await budget(), false);
    await db.query(
      "update scout_source_configs set enabled=false where id=$1",
      [config],
    );
    assert.equal(await budget(), false);
    await db.exec(
      "insert into scout_submissions(owner_id,guild_id,interaction_id,data,expires_at) values ('a','g','expired','{}',now()-interval '1 day'); select scout_cleanup_classifieds();",
    );
    assert.equal(
      (await db.query("select * from scout_submissions")).rows.length,
      0,
    );
    await db.exec(
      "select scout_purge_classifieds('facebook_marketplace'); set role anon;",
    );
    await assert.rejects(db.query("select * from scout_submissions"));
    await assert.rejects(db.query("select scout_cleanup_classifieds()"));
  } finally {
    await db.close();
  }
});
