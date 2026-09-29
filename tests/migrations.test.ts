import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { WatchConfig } from "../src/config/schema.js";

const migrations = readdirSync("supabase/migrations").sort();
const apply = async (db: PGlite, files: string[]) => {
  for (const file of files)
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
};
const area = { label: "Campbell, CA", postalCode: null, radiusMiles: 20 };
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

test("migrations end eBay-only: watches convert, Marketplace data and tables are removed", async () => {
  assert.equal(migrations.at(-1), "202609300001_remove_marketplace.sql");
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    const removal = migrations.indexOf("202609300001_remove_marketplace.sql");
    await apply(db, migrations.slice(0, 3));
    // Pre-rework watches: an eBay deal watch and a Marketplace-only match watch.
    for (const config of [
      legacy,
      {
        ...legacy,
        name: "Local mice",
        purpose: "match",
        sources: ["facebook_marketplace"],
        location: area,
        deliveryModes: ["pickup"],
        maxAskingPrice: 20,
        estimatedTravelCost: 0,
        intervalMinutes: 1440,
      },
    ])
      await db.query(
        "insert into scout_watches(owner_id,guild_id,config) values('alice','g',$1)",
        [JSON.stringify(config)],
      );
    await apply(db, migrations.slice(3, removal));
    // A both-source keyword watch plus Marketplace artifacts from the polling era.
    const both = (
      await db.query<{ id: string }>(
        "insert into scout_watches(owner_id,guild_id,config) values('alice','g',$1) returning id",
        [
          JSON.stringify({
            name: "Lofree",
            rawQuery: "lofree flow keyboard",
            searchTerms: "lofree flow keyboard",
            excludedKeywords: [],
            constraints: [],
            conditions: ["new", "used"],
            sources: ["ebay", "facebook_marketplace"],
            location: area,
            deliveryModes: ["pickup"],
            estimatedTravelCost: 0,
            minPrice: null,
            maxPrice: null,
            minSellerPercent: null,
            country: "US",
            currency: "USD",
            buying: "fixed",
            channelId: "c",
            intervalMinutes: 90,
          }),
        ],
      )
    ).rows[0]!.id;
    await db.exec(`
      insert into scout_listings(id,data) values
        ('facebook_marketplace:brightdata:1','{"source":"facebook_marketplace"}'),
        ('v1|2|0','{"source":"ebay"}');
      insert into scout_jobs(dedupe_key,kind,payload) values ('snapshot:sd:0','snapshot','{}');
      insert into scout_usage(service,calls) values ('brightdata_records',10),('llm',3);
      insert into scout_user_defaults values ('alice','g','{}');
    `);
    await db.query(
      "insert into scout_ingestion_runs(watch_id,status,query_key) values($1,'succeeded','k')",
      [both],
    );
    for (const listing of ["facebook_marketplace:brightdata:1", "v1|2|0"])
      await db.query("select scout_reserve_alert($1,1,$2,'{}')", [
        both,
        listing,
      ]);
    await apply(db, migrations.slice(removal));

    const watches = (
      await db.query<{ config: any; active: boolean }>(
        "select config,active from scout_watches order by config->>'name'",
      )
    ).rows;
    const byName = Object.fromEntries(watches.map((w) => [w.config.name, w]));
    for (const w of watches) WatchConfig.parse(w.config);
    assert.equal(byName["Lofree"]!.active, true);
    assert.equal(byName["Mice"]!.active, true);
    assert.equal(byName["Mice"]!.config.maxPrice, 85);
    assert.equal(byName["Mice"]!.config.minSellerPercent, 98);
    // A watch that only searched Marketplace has nothing left to search.
    assert.equal(byName["Local mice"]!.active, false);
    assert.equal(
      (
        await db.query(
          "select * from scout_listings where data->>'source'='facebook_marketplace'",
        )
      ).rows.length,
      0,
    );
    assert.deepEqual(
      (
        await db.query<{ listing_id: string }>(
          "select listing_id from scout_alerts",
        )
      ).rows.map((r) => r.listing_id),
      ["v1|2|0"],
    );
    assert.deepEqual(
      (
        await db.query<{ service: string }>("select service from scout_usage")
      ).rows.map((r) => r.service),
      ["llm"],
    );
    assert.equal((await db.query("select * from scout_jobs")).rows.length, 0);
    await assert.rejects(
      db.exec(
        "insert into scout_jobs(dedupe_key,kind,payload) values('x','snapshot','{}')",
      ),
    );
    for (const table of [
      "scout_ingestion_runs",
      "scout_source_configs",
      "scout_source_usage",
      "scout_user_defaults",
      "scout_comparables",
      "scout_submissions",
      "scout_evaluations",
    ])
      await assert.rejects(db.query(`select * from ${table}`));
    for (const fn of [
      "scout_take_monthly_budget('x',1,1)",
      "scout_cleanup_classifieds()",
      "scout_purge_classifieds('ebay')",
    ])
      await assert.rejects(db.query(`select ${fn}`));
    // The Marketplace watch cap no longer applies.
    for (let n = 0; n < 12; n++)
      await db.query(
        "insert into scout_watches(owner_id,guild_id,config) values($1,'g',$2)",
        [`u${n}`, JSON.stringify(byName["Lofree"]!.config)],
      );
    await db.exec("set role anon;");
    await assert.rejects(db.query("select * from scout_watches"));
    await assert.rejects(db.query("select scout_enqueue_due()"));
    await db.exec("reset role;");
  } finally {
    await db.close();
  }
});
