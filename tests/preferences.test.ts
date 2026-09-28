import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { updateDefaults, prepareWatch } from "../src/config/preferences.js";
import { parsed } from "../src/fixtures.js";
import { preview } from "../src/cloud/discord.js";
import { CloudCommands } from "../src/cloud/commands.js";
import { CloudStore } from "../src/cloud/store.js";
import { DiscordHttp } from "../src/cloud/discord.js";
import { cloudConfig } from "../src/cloud/config.js";
import { commands } from "../src/commands/definitions.js";

const defaults = updateDefaults(null, {
  zipcode: "97201",
  radius: 25,
  delivery: "pickup",
});
const vague = {
  ...parsed,
  constraints: [],
  recommendations: [
    {
      phrase: "lightweight",
      reason: "A suggested lightweight threshold for you to confirm.",
      constraint: {
        key: "weight_grams",
        operator: "lte" as const,
        value: "50",
      },
    },
  ],
};
const prepare = () =>
  prepareWatch(
    vague,
    "lightweight gaming mouse under $20",
    "channel",
    defaults,
  );

test("defaults validate location, radius, delivery and preserve partial updates", () => {
  assert.equal(defaults.location.postalCode, "97201");
  assert.equal(
    updateDefaults(defaults, { radius: 10 }).location.label,
    "97201",
  );
  const city = updateDefaults(defaults, { city: "Portland, OR" });
  assert.equal(city.location.postalCode, null);
  for (const opts of [
    { city: "Portland", zipcode: "97201" },
    { radius: 0 },
    { radius: 101 },
    { zipcode: "abcde" },
    { city: "123 Main Street" },
    { delivery: "teleport" },
  ])
    assert.throws(() => updateDefaults(defaults, opts));
  assert.throws(() => updateDefaults(null, { city: "Portland, OR" }));
  assert.ok(commands.find((c: any) => c.name === "defaults"));
});

test("recommendations become editable draft criteria for a both-source watch", () => {
  const result = prepare();
  assert.deepEqual(result.config.sources, ["ebay", "facebook_marketplace"]);
  assert.equal(result.config.intervalMinutes, 1440);
  assert.deepEqual(result.config.location, defaults.location);
  assert.deepEqual(result.config.deliveryModes, ["pickup"]);
  assert.equal(result.config.maxPrice, 85);
  assert.match(result.editableQuery, /weight_grams lte 50/);
  assert.ok(
    result.config.constraints.some(
      (c) => c.key === "weight_grams" && c.value === "50",
    ),
  );
  const msg = preview(result.config, "draft", result.notes);
  assert.match(msg.content!, /Confirm recommendation/);
  assert.match(msg.content!, /50 g/);
  assert.match(msg.content!, /eBay \+ Facebook Marketplace/);
  assert.match(msg.content!, /not connected yet/);
  assert.match(msg.content!, /<#channel>/);
  assert.doesNotMatch(
    msg.content!,
    /verified sales|Minimum discount|profit|categor|all-in/i,
  );
  assert.doesNotMatch(
    preview(result.config, "draft", result.notes, true).content!,
    /not connected/,
  );
});

test("sources default to both; opting out is explicit and eBay-only needs no location", () => {
  assert.throws(
    () => prepareWatch(parsed, "mouse", "c", null),
    /defaults|eBay only/,
  );
  const ebay = prepareWatch(parsed, "mouse", "c", null, undefined, "ebay_only");
  assert.deepEqual(ebay.config.sources, ["ebay"]);
  assert.equal(ebay.config.location, null);
  assert.equal(ebay.config.deliveryModes, null);
  assert.equal(ebay.config.intervalMinutes, 60);
  assert.deepEqual(
    prepareWatch(parsed, "mouse", "c", defaults, undefined, "facebook_only")
      .config.sources,
    ["facebook_marketplace"],
  );
  // Query wording can scope the watch; the explicit option still wins.
  const scoped = { ...parsed, sources: ["ebay" as const] };
  assert.deepEqual(
    prepareWatch(scoped, "mouse on ebay", "c", null).config.sources,
    ["ebay"],
  );
  assert.deepEqual(
    prepareWatch(scoped, "mouse on ebay", "c", defaults, undefined, "both")
      .config.sources,
    ["ebay", "facebook_marketplace"],
  );
  // Default exclusions do not fight the search itself.
  const parts = prepareWatch(
    { ...parsed, searchTerms: "gpu for parts" },
    "gpu for parts",
    "c",
    null,
    undefined,
    "ebay_only",
  ).config.excludedKeywords;
  assert.ok(!parts.includes("for parts"));
  assert.ok(parts.includes("broken"));
});

test("updates replace criteria but keep unstated sources, area, price limits, channel and frequency", () => {
  const previous = {
    ...prepare().config,
    sources: ["ebay" as const],
    location: null,
    deliveryModes: null,
    minPrice: 10,
    maxPrice: 40,
    channelId: "old-channel",
    intervalMinutes: 180,
  };
  const next = prepareWatch(
    {
      ...parsed,
      searchTerms: "wired gaming mouse",
      maxPrice: null,
      constraints: [],
    },
    "wired gaming mouse",
    "new-channel",
    null,
    previous,
  ).config;
  assert.equal(next.searchTerms, "wired gaming mouse");
  assert.deepEqual(next.constraints, []);
  assert.deepEqual(next.sources, ["ebay"]);
  assert.equal(next.minPrice, 10);
  assert.equal(next.maxPrice, 40);
  assert.equal(next.channelId, "old-channel");
  assert.equal(next.intervalMinutes, 180);
  const priced = prepareWatch(
    { ...parsed, maxPrice: 30 },
    "mouse under 30",
    "c",
    null,
    previous,
  ).config;
  assert.equal(priced.minPrice, null);
  assert.equal(priced.maxPrice, 30);
  // Adding Marketplace to an hourly watch enforces the daily minimum.
  const widened = prepareWatch(
    parsed,
    "mouse",
    "c",
    defaults,
    previous,
    "both",
  ).config;
  assert.equal(widened.intervalMinutes, 1440);
});

test("explicit settings win; unresolved/conflicting/invalid interpretations cannot be confirmed", () => {
  const location = { label: "Seattle, WA", postalCode: null, radiusMiles: 10 };
  const result = prepareWatch(
    { ...parsed, location, deliveryModes: ["shipping"] },
    "mouse",
    "c",
    defaults,
  );
  assert.deepEqual(result.config.location, location);
  assert.deepEqual(result.config.deliveryModes, ["shipping"]);
  assert.throws(
    () =>
      prepareWatch(
        { ...vague, constraints: [vague.recommendations[0]!.constraint] },
        "mouse",
        "c",
        defaults,
      ),
    /conflicting/,
  );
  assert.throws(
    () =>
      prepareWatch(
        { ...parsed, clarifications: ["Which size?"] },
        "mouse",
        "c",
        defaults,
      ),
    /clarify/,
  );
  assert.throws(
    () => prepareWatch({ ...parsed, confidence: 0.3 }, "mouse", "c", defaults),
    /uncertain/,
  );
  assert.throws(
    () =>
      prepareWatch(
        {
          ...vague,
          recommendations: [
            {
              ...vague.recommendations[0]!,
              constraint: {
                key: "weight_grams",
                operator: "lte",
                value: "NaN",
              },
            },
          ],
        },
        "mouse",
        "c",
        defaults,
      ),
    /numeric/,
  );
});

test("cloud /defaults reads and writes without using Gemini", async (t) => {
  const db = new CloudStore("https://test", "secret");
  let saved: unknown;
  t.mock.method(db, "defaults", async () => null);
  t.mock.method(
    db,
    "saveDefaults",
    async (owner: string, guild: string, config: unknown) => {
      assert.equal(owner, "alice");
      assert.equal(guild, "456");
      saved = config;
    },
  );
  const config = cloudConfig({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    WORKER_SECRET: "w".repeat(64),
    DISCORD_TOKEN: "fake-token",
    DISCORD_APPLICATION_ID: "123",
    DISCORD_GUILD_ID: "456",
  });
  const handler = new CloudCommands(
    db,
    {} as DiscordHttp,
    {
      model: "test",
      parseWatch: async () => {
        throw new Error("Must not call Gemini");
      },
      normalize: async () => {
        throw new Error("Must not call Gemini");
      },
    },
    config,
  );
  const i = {
    id: "id",
    application_id: "123",
    guild_id: "456",
    type: 2,
    token: "token",
    member: { user: { id: "alice" } },
    data: {
      name: "defaults",
      options: [
        { name: "zipcode", value: "97201", type: 3 },
        { name: "radius", value: 25, type: 4 },
        { name: "delivery", value: "pickup", type: 3 },
      ],
    },
  };
  assert.match((await handler.run(i)).content!, /Saved/);
  assert.deepEqual(saved, defaults);
  assert.match(
    (await handler.run({ ...i, data: { name: "defaults", options: [] } }))
      .content!,
    /No defaults/,
  );
});

test("PostgreSQL enforces default privacy and caps watches that include Marketplace", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    for (const file of [
      "202609170001_scout.sql",
      "202609240001_classifieds.sql",
      "202609240002_preferences.sql",
      "202609280001_keyword_watch.sql",
    ])
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await db.query(
      "insert into scout_user_defaults values ('alice','guild',$1)",
      [JSON.stringify(defaults)],
    );
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role};`);
      await assert.rejects(db.query("select * from scout_user_defaults"));
      await db.exec("reset role;");
    }
    const config = JSON.stringify(prepare().config);
    for (let n = 0; n < 10; n++)
      await db.query(
        "insert into scout_watches(owner_id,guild_id,config) values($1,'guild',$2)",
        [`user${n}`, config],
      );
    await assert.rejects(
      db.query(
        "insert into scout_watches(owner_id,guild_id,config) values('extra','guild',$1)",
        [config],
      ),
      /Maximum 10/,
    );
    await db.exec(
      "update scout_watches set active=false where owner_id='user0'",
    );
    await assert.rejects(
      db.query(
        "insert into scout_watches(owner_id,guild_id,config) values('extra','guild',$1)",
        [JSON.stringify({ ...prepare().config, intervalMinutes: 60 })],
      ),
      /1440/,
    );
    await db.query(
      "insert into scout_watches(owner_id,guild_id,config) values('extra','guild',$1)",
      [config],
    );
    await assert.rejects(
      db.exec("update scout_watches set active=true where owner_id='user0'"),
      /Maximum 10/,
    );
    // eBay-only watches are outside the Marketplace budget cap and daily cadence.
    await db.query(
      "insert into scout_watches(owner_id,guild_id,config) values('ebay','guild',$1)",
      [
        JSON.stringify({
          ...prepare().config,
          sources: ["ebay"],
          intervalMinutes: 60,
        }),
      ],
    );
  } finally {
    await db.close();
  }
});
