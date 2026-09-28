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
  marketplaceCondition,
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

test("disabled, unconfigured or city-less legs are skipped per watch, not the whole watch", () => {
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
  assert.deepEqual(scheduledSources(both, { facebook: true, ebay: false }), {
    scan: ["facebook_marketplace"],
    skipped: [{ source: "ebay", reason: "ebay_not_configured" }],
  });
  for (const location of [
    null,
    { label: "97201", postalCode: "97201", radiusMiles: 25, city: null },
  ])
    assert.deepEqual(
      scheduledSources({ ...both, location }, { facebook: true }).skipped,
      [{ source: "facebook_marketplace", reason: "missing_city" }],
    );
  assert.deepEqual(
    scheduledSources(
      {
        ...both,
        location: {
          ...area,
          label: "97201",
          postalCode: "97201",
          city: "Portland, OR",
        },
      },
      { facebook: true },
    ).scan,
    ["ebay", "facebook_marketplace"],
  );
  assert.deepEqual(scheduledSources(watch, { facebook: true }).scan, ["ebay"]);
});

test("Marketplace env is a real toggle; blank secrets fall back to defaults", () => {
  assert.equal(getEnv({}).FACEBOOK_MONITORING_ENABLED, false);
  assert.equal(
    getEnv({ FACEBOOK_MONITORING_ENABLED: "true" }).FACEBOOK_MONITORING_ENABLED,
    true,
  );
  assert.throws(() => getEnv({ FACEBOOK_MONITORING_ENABLED: "yes" }));
  const blank = getEnv({
    BRIGHT_DATA_DATASET_ID: "",
    BRIGHT_DATA_MAX_CALLS_PER_DAY: "",
    DRY_RUN: "",
  });
  assert.equal(blank.BRIGHT_DATA_DATASET_ID, "gd_lvt9iwuh6fbcwmx1a");
  assert.equal(blank.BRIGHT_DATA_MAX_CALLS_PER_DAY, 2000);
  assert.equal(blank.DRY_RUN, true);
  assert.equal(blank.BRIGHT_DATA_INITIAL_RECORDS, 10);
  assert.equal(blank.BRIGHT_DATA_POLL_RECORDS, 2);
});

// Shape of a Bright Data "Facebook Marketplace listings" record (synthetic values).
const brightDataRecord = (id: string, extra: object = {}) => ({
  url: `https://www.facebook.com/marketplace/item/${id}`,
  title: "Logitech G305 Wireless Gaming Mouse",
  initial_price: 30,
  final_price: 25,
  currency: "USD",
  product_id: id,
  breadcrumbs: null,
  condition: "Used - Good",
  description: "Works great. Text 503-555-0100 or mouse@example.com",
  location: "Beaverton, OR",
  country_code: null,
  root_category: "Electronics",
  images: ["https://scontent.example/photo.jpg"],
  seller_description: "Works great.",
  profile_id: "123456789",
  listing_date: "2026-09-28T03:30:11.000Z",
  is_sold: false,
  ...extra,
});
const portland: WatchConfig = {
  ...both,
  searchTerms: "gaming mouse",
  location: {
    label: "97201",
    postalCode: "97201",
    radiusMiles: 25,
    city: "Portland, OR",
  },
};
test("Bright Data connector triggers a capped keyword search, polls and maps records", async (t) => {
  const calls: { url: string; init: any }[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/trigger?"))
      return Response.json({ snapshot_id: "sd_test1" });
    if (u.includes("/progress/")) return Response.json({ status: "ready" });
    if (u.includes("/snapshot/"))
      return Response.json([
        brightDataRecord("111"),
        brightDataRecord("222", { condition: "New", listing_date: "bad" }),
        brightDataRecord("333", { currency: "EUR" }),
        { error: "Page not found", error_code: "dead_page" },
      ]);
    throw new Error(`Unexpected ${u}`);
  });
  assert.throws(
    () => new BrightDataSource(getEnv({ FACEBOOK_MONITORING_ENABLED: "true" })),
    /BRIGHT_DATA_API_KEY/,
  );
  const env = getEnv({
    FACEBOOK_MONITORING_ENABLED: "true",
    BRIGHT_DATA_API_KEY: "fake-key",
  });
  const bd = new BrightDataSource(env);
  assert.equal(
    await bd.trigger(portland, { limit: 10, recentOnly: false }),
    "sd_test1",
  );
  const trigger = new URL(calls[0]!.url);
  assert.equal(trigger.pathname, "/datasets/v3/trigger");
  assert.deepEqual(Object.fromEntries(trigger.searchParams), {
    dataset_id: "gd_lvt9iwuh6fbcwmx1a",
    type: "discover_new",
    discover_by: "keyword",
    include_errors: "true",
    limit_per_input: "10",
  });
  assert.equal(calls[0]!.init.headers.Authorization, "Bearer fake-key");
  assert.deepEqual(JSON.parse(calls[0]!.init.body), {
    input: [
      {
        keyword: "gaming mouse",
        city: "Portland, OR",
        radius: 25,
        date_listed: "",
      },
    ],
  });
  await bd.trigger(portland, { limit: 2, recentOnly: true });
  assert.equal(
    JSON.parse(calls[1]!.init.body).input[0].date_listed,
    "Last 24 hours",
  );
  assert.equal(new URL(calls[1]!.url).searchParams.get("limit_per_input"), "2");
  assert.equal(await bd.progress("sd_test1"), "ready");
  const result = await bd.download("sd_test1");
  assert.deepEqual(
    {
      received: result.received,
      errors: result.errors,
      rejected: result.rejected,
    },
    { received: 3, errors: 1, rejected: 1 },
  );
  const [used, fresh] = result.listings;
  assert.equal(used!.id, "facebook_marketplace:brightdata:111");
  assert.equal(used!.url, "https://www.facebook.com/marketplace/item/111/");
  assert.equal(used!.price, 25);
  assert.equal(used!.condition, "used");
  assert.equal(used!.listedAt, "2026-09-28T03:30:11.000Z");
  assert.equal(used!.provenance!.locationLabel, "Beaverton, OR");
  assert.equal(fresh!.condition, "new");
  assert.equal(fresh!.listedAt, null);
  const stored = JSON.stringify(result.listings);
  assert.doesNotMatch(
    stored,
    /503-555-0100|mouse@example|profile|123456789|scontent/,
  );
  // The kill switch and missing city block a paid search before any request.
  const before = calls.length;
  await assert.rejects(
    new BrightDataSource({
      ...env,
      FACEBOOK_MONITORING_ENABLED: false,
    }).trigger(portland, { limit: 2, recentOnly: true }),
    /disabled/,
  );
  await assert.rejects(
    bd.trigger(
      { ...portland, location: { ...portland.location!, city: null } },
      {
        limit: 2,
        recentOnly: true,
      },
    ),
    /city/,
  );
  await assert.rejects(
    bd.trigger(watch, { limit: 2, recentOnly: true }),
    /does not include/,
  );
  assert.equal(calls.length, before);
});

test("a failed paid trigger is never retried automatically", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", { status: 502 });
  });
  const bd = new BrightDataSource(
    getEnv({ FACEBOOK_MONITORING_ENABLED: "true", BRIGHT_DATA_API_KEY: "k" }),
  );
  await assert.rejects(bd.trigger(portland, { limit: 2, recentOnly: true }));
  assert.equal(calls, 1);
});

test("Marketplace conditions map to watch conditions", () => {
  for (const [value, expected] of [
    ["New", "new"],
    ["Used - like new", "used"],
    ["Used - Like New", "used"],
    ["Used - Good", "used"],
    ["Used - Fair", "used"],
    ["Refurbished", "refurbished"],
    [null, "unknown"],
  ] as const)
    assert.equal(marketplaceCondition(value), expected);
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
  "202609290001_marketplace_polling.sql",
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

test("polling migration allows snapshot jobs, hourly 5-watch cap and a monthly record budget", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    for (const file of migrations)
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await db.exec(
      "insert into scout_jobs(dedupe_key,kind,payload) values('snapshot:x:0','snapshot','{}')",
    );
    const take = async (amount: number) =>
      (
        await db.query<{ ok: boolean }>(
          "select scout_take_monthly_budget('brightdata_records',$1,5) ok",
          [amount],
        )
      ).rows[0]!.ok;
    assert.equal(await take(3), true);
    assert.equal(await take(3), false);
    assert.equal(await take(-2), true);
    assert.equal(await take(3), true);
    assert.equal(await take(1), true);
    assert.equal(await take(1), false);
    // Earlier months do not count against this month.
    await db.exec(
      "update scout_usage set day=day-interval '40 days' where service='brightdata_records'",
    );
    assert.equal(await take(5), true);
    const config = {
      ...both,
      location: { ...area, city: "Santa Cruz, CA" },
      intervalMinutes: 60,
    };
    for (let n = 0; n < 5; n++)
      await db.query(
        "insert into scout_watches(owner_id,guild_id,config) values($1,'g',$2)",
        [`user${n}`, JSON.stringify(config)],
      );
    await assert.rejects(
      db.query(
        "insert into scout_watches(owner_id,guild_id,config) values('extra','g',$1)",
        [JSON.stringify(config)],
      ),
      /Maximum 5 active Marketplace watches/,
    );
    await db.exec(
      "update scout_watches set active=false where owner_id='user0'",
    );
    await assert.rejects(
      db.query(
        "insert into scout_watches(owner_id,guild_id,config) values('extra','g',$1)",
        [JSON.stringify({ ...config, intervalMinutes: 59 })],
      ),
      /at least 60 minutes/,
    );
    const watchId = (
      await db.query<{ id: string }>(
        "insert into scout_watches(owner_id,guild_id,config) values('extra','g',$1) returning id",
        [JSON.stringify(config)],
      )
    ).rows[0]!.id;
    await db.query(
      "insert into scout_ingestion_runs(watch_id,status,query_key,provider_request_id) values($1,'running','k','sd_1')",
      [watchId],
    );
    await db.exec("set role anon;");
    await assert.rejects(
      db.query("select scout_take_monthly_budget('brightdata_records',1,5)"),
    );
    await assert.rejects(db.query("select * from scout_ingestion_runs"));
    await db.exec("reset role;");
  } finally {
    await db.close();
  }
});
