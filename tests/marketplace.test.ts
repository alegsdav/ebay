import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  assertSourceAccess,
  scheduledSources,
} from "../src/connectors/source.js";
import {
  BrightDataSource,
  NotImplementedError,
  marketplaceIdentity,
  marketplaceListing,
} from "../src/connectors/brightdata.js";
import { redact } from "../src/privacy.js";
import { watch } from "../src/fixtures.js";
import { Listing, WatchConfig } from "../src/config/schema.js";
import { getEnv } from "../src/config/env.js";

const area = { label: "Santa Cruz, CA", postalCode: null, radiusMiles: 25 };
const both: WatchConfig = {
  ...watch,
  sources: ["ebay", "facebook_marketplace"],
  location: area,
  deliveryModes: ["pickup"],
  intervalMinutes: 1440,
};

test("source access fails closed; only reviewed providers can be enabled", () => {
  assertSourceAccess("ebay", "ebay", "authorized_api", true);
  assertSourceAccess(
    "facebook_marketplace",
    "brightdata",
    "licensed_provider",
    true,
  );
  assert.throws(() =>
    assertSourceAccess(
      "facebook_marketplace",
      "brightdata",
      "licensed_provider",
      false,
    ),
  );
  for (const [provider, mode] of [
    ["manual", "user_submitted"],
    ["unreviewed", "licensed_provider"],
    ["brightdata", "scrape"],
    ["brightdata", "authorized_api"],
  ])
    assert.throws(() =>
      assertSourceAccess("facebook_marketplace", provider!, mode!, true),
    );
  assert.throws(() =>
    assertSourceAccess("ebay", "ebay", "authorized_api", false),
  );
});

test("disabled or incomplete Marketplace legs are skipped per watch, not the whole watch", () => {
  assert.deepEqual(scheduledSources(both, { facebook: false }), {
    scan: ["ebay"],
    skipped: [
      {
        source: "facebook_marketplace",
        reason: "facebook_monitoring_disabled",
      },
    ],
  });
  assert.deepEqual(scheduledSources(both, { facebook: true }).scan, [
    "ebay",
    "facebook_marketplace",
  ]);
  assert.deepEqual(
    scheduledSources({ ...both, location: null }, { facebook: true }).skipped,
    [{ source: "facebook_marketplace", reason: "missing_location" }],
  );
  assert.deepEqual(
    scheduledSources(
      { ...both, sources: ["facebook_marketplace"] },
      { facebook: false },
    ).scan,
    [],
  );
  assert.deepEqual(scheduledSources(watch, { facebook: true }).scan, ["ebay"]);
});

test("FACEBOOK_MONITORING_ENABLED is a real toggle that defaults off", () => {
  assert.equal(getEnv({}).FACEBOOK_MONITORING_ENABLED, false);
  assert.equal(
    getEnv({ FACEBOOK_MONITORING_ENABLED: "true" }).FACEBOOK_MONITORING_ENABLED,
    true,
  );
  assert.throws(() => getEnv({ FACEBOOK_MONITORING_ENABLED: "yes" }));
  assert.equal(getEnv({}).BRIGHT_DATA_API_KEY, "");
});

test("Bright Data stub fails cleanly without any network request", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("No network permitted");
  });
  const off = new BrightDataSource(getEnv({}));
  await assert.rejects(async () => {
    for await (const _ of off.search(both));
  }, /disabled/);
  const on = new BrightDataSource(
    getEnv({ FACEBOOK_MONITORING_ENABLED: "true" }),
  );
  await assert.rejects(async () => {
    for await (const _ of on.search(both));
  }, NotImplementedError);
  await assert.rejects(async () => {
    for await (const _ of on.search({ ...both, location: null }));
  }, /city/);
  await assert.rejects(async () => {
    for await (const _ of on.search(watch));
  }, /does not include/);
  await assert.rejects(
    on.detail({} as Listing),
    /Bright Data connector not yet implemented/,
  );
});

test("Marketplace records get canonical identity, redacted text and provenance", async () => {
  const l = await marketplaceListing({
    url: "https://m.facebook.com/marketplace/item/123/?tracking=private",
    title: "Acme Feather 2 — text 831-555-1234",
    description:
      "Email seller@example.com, pickup at 123 West Main Street, Santa Cruz",
    price: 50,
    locationLabel: "Santa Cruz, CA",
  });
  assert.equal(l.id, "facebook_marketplace:brightdata:123");
  assert.equal(l.url, "https://www.facebook.com/marketplace/item/123/");
  assert.doesNotMatch(
    JSON.stringify(l),
    /831-555-1234|seller@example|123 West Main|tracking/,
  );
  assert.equal(l.provenance!.evidenceHash.length, 64);
  assert.equal(l.provenance!.accessMode, "licensed_provider");
  assert.equal(l.sellerPercent, null);
  assert.equal(l.condition, "unknown");
  assert.equal(Listing.safeParse({ ...l, source: "ebay" }).success, false);
  for (const url of [
    "https://evil.facebook.com/marketplace/item/1",
    "https://facebook.com.evil.org/marketplace/item/1",
    "http://facebook.com/marketplace/item/1",
    "https://user:pass@facebook.com/marketplace/item/1",
    "https://facebook.com/profile.php?id=1",
    "https://facebook.com:444/marketplace/item/1",
  ])
    assert.throws(() => marketplaceIdentity(url));
  await assert.rejects(
    marketplaceListing({
      url: "https://www.facebook.com/marketplace/item/1/",
      title: "x",
      price: -1,
    }),
  );
  assert.match(redact("a@b.com 8315551234"), /removed/);
});

const migrations = [
  "202609170001_scout.sql",
  "202609240001_classifieds.sql",
  "202609240002_preferences.sql",
  "202609280001_keyword_watch.sql",
];
test("keyword-watch migration converts watches, drops pricing tables and keeps grants", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    for (const file of migrations.slice(0, 3))
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    // A pre-rework eBay deal watch and a Marketplace match watch.
    const legacy = {
      name: "Mice",
      category: "gaming_mice",
      rawQuery: "mice",
      searchTerms: "gaming mouse",
      excludedKeywords: ["broken"],
      constraints: [],
      conditions: ["used"],
      minAllIn: 10,
      maxAllIn: 85,
      minDiscountPercent: 20,
      minProfit: 0,
      minSellerPercent: 98,
      country: "US",
      currency: "USD",
      minComparables: 5,
      lookbackDays: 90,
      minConfidence: 0.85,
      buying: "fixed",
      channelId: "c",
      possibleChannelId: null,
      intervalMinutes: 60,
      fees: { taxRate: 0.08 },
    };
    const marketplace = {
      ...legacy,
      purpose: "match",
      sources: ["facebook_marketplace"],
      location: area,
      deliveryModes: ["pickup"],
      maxAskingPrice: 20,
      estimatedTravelCost: 0,
      intervalMinutes: 1440,
    };
    for (const config of [legacy, marketplace])
      await db.query(
        "insert into scout_watches(owner_id,guild_id,config) values('alice','g',$1)",
        [JSON.stringify(config)],
      );
    await db.query(
      "insert into scout_drafts(owner_id,guild_id,config,query) values('alice','g','{}','q')",
    );
    await db.exec(
      "insert into scout_listings(id,data) values('l','{}'); insert into scout_normalized values('l','gaming_mice','h','{}','m','p');",
    );
    await db.exec(readFileSync(`supabase/migrations/${migrations[3]}`, "utf8"));
    const rows = (
      await db.query<{ config: any; revision: number }>(
        "select config,revision from scout_watches order by (config->>'intervalMinutes')::int",
      )
    ).rows;
    const [ebay, fb] = rows.map((r) => WatchConfig.parse(r.config));
    assert.deepEqual(ebay!.sources, ["ebay"]);
    assert.equal(ebay!.minPrice, 10);
    assert.equal(ebay!.maxPrice, 85);
    assert.equal(ebay!.minSellerPercent, 98);
    assert.deepEqual(fb!.sources, ["facebook_marketplace"]);
    assert.equal(fb!.maxPrice, 20);
    assert.deepEqual(fb!.location, area);
    assert.ok(rows.every((r) => r.revision === 2));
    assert.equal((await db.query("select * from scout_drafts")).rows.length, 0);
    for (const table of [
      "scout_comparables",
      "scout_submissions",
      "scout_evaluations",
    ])
      await assert.rejects(db.query(`select * from ${table}`));
    await assert.rejects(
      db.query("select scout_consume_submission(gen_random_uuid(),'a','g')"),
    );
    // Normalization cache is keyed by listing and hash only.
    await db.exec(
      "insert into scout_normalized(listing_id,hash,data,model,prompt_version) values('l','h1','{}','m','p'),('l','h2','{}','m','p');",
    );
    await assert.rejects(
      db.exec(
        "insert into scout_normalized(listing_id,hash,data,model,prompt_version) values('l','h1','{}','m','p')",
      ),
    );
    const watchId = (
      await db.query<{ id: string }>("select id from scout_watches limit 1")
    ).rows[0]!.id;
    const alert = (
      await db.query<{ id: string }>(
        "select scout_reserve_alert($1,2,'l','{}') id",
        [watchId],
      )
    ).rows[0]!.id;
    await db.query(
      "insert into scout_feedback(alert_id,user_id,action) values($1,'alice','not_relevant')",
      [alert],
    );
    await assert.rejects(
      db.query(
        "insert into scout_feedback(alert_id,user_id,action) values($1,'bob','bogus')",
        [alert],
      ),
    );
    // Cleanup keeps only the ingestion-run retention; purge accepts any known source.
    await db.exec(
      "insert into scout_ingestion_runs(status,started_at) values('failed',now()-interval '40 days'); select scout_cleanup_classifieds();",
    );
    assert.equal(
      (await db.query("select * from scout_ingestion_runs")).rows.length,
      0,
    );
    await db.exec(
      "insert into scout_listings(id,data) values('fb','{\"source\":\"facebook_marketplace\"}'); select scout_purge_classifieds('facebook_marketplace');",
    );
    assert.equal(
      (await db.query("select * from scout_listings where id='fb'")).rows
        .length,
      0,
    );
    await db.exec("select scout_purge_classifieds('ebay');");
    await assert.rejects(db.query("select scout_purge_classifieds('other')"));
    const config = (
      await db.query<{ id: string }>(
        "insert into scout_source_configs(source,provider,access_mode,enabled,terms_reviewed_at,terms_reference,daily_request_limit,daily_cost_limit) values ('facebook_marketplace','brightdata','licensed_provider',true,now(),'test only',1,1) returning id",
      )
    ).rows[0]!.id;
    const budget = async () =>
      (
        await db.query<{ ok: boolean }>(
          "select scout_take_source_budget($1,1) ok",
          [config],
        )
      ).rows[0]!.ok;
    assert.equal(await budget(), true);
    assert.equal(await budget(), false);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role};`);
      await assert.rejects(db.query("select * from scout_normalized"));
      await assert.rejects(db.query("select * from scout_feedback"));
      await assert.rejects(db.query("select scout_cleanup_classifieds()"));
      await assert.rejects(db.query("select scout_purge_classifieds('ebay')"));
      await db.exec("reset role;");
    }
  } finally {
    await db.close();
  }
});
