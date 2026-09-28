import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { updateDefaults, prepareWatch } from "../src/config/preferences.js";
import { parsed, fees } from "../src/fixtures.js";
import { Store } from "../src/database/store.js";
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
    fees,
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

test("recommendations become editable draft criteria, not automatic watch activation", () => {
  const result = prepare();
  assert.deepEqual(result.config.sources, ["facebook_marketplace"]);
  assert.equal(result.config.purpose, "match");
  assert.equal(result.config.intervalMinutes, 1440);
  assert.deepEqual(result.config.location, defaults.location);
  assert.deepEqual(result.config.deliveryModes, ["pickup"]);
  assert.match(result.editableQuery, /weight_grams lte 50/);
  const msg = preview(result.config, "draft", result.notes);
  assert.match(msg.content!, /Confirm recommendation/);
  assert.match(msg.content!, /50 g/);
  assert.match(msg.content!, /NOT running/);
  assert.doesNotMatch(msg.content!, /verified sales|Minimum discount/);
  const store = new Store(":memory:");
  try {
    const id = store.draft(
      "alice",
      "guild",
      result.config,
      result.editableQuery,
    );
    assert.equal(store.watches().length, 0);
    assert.throws(() => store.confirmDraft(id, "bob", "guild"));
    store.confirmDraft(id, "alice", "guild");
    assert.equal(store.watches().length, 1);
  } finally {
    store.close();
  }
});

test("explicit settings win; unresolved/conflicting/invalid interpretations cannot be confirmed", () => {
  const location = { label: "Seattle, WA", postalCode: null, radiusMiles: 10 };
  const result = prepareWatch(
    { ...parsed, location, deliveryModes: ["shipping"] },
    "mouse",
    "c",
    fees,
    defaults,
  );
  assert.deepEqual(result.config.location, location);
  assert.deepEqual(result.config.deliveryModes, ["shipping"]);
  assert.throws(
    () => prepareWatch(parsed, "mouse", "c", fees, null),
    /defaults/,
  );
  assert.throws(
    () =>
      prepareWatch(
        { ...vague, constraints: [vague.recommendations[0]!.constraint] },
        "mouse",
        "c",
        fees,
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
        fees,
        defaults,
      ),
    /clarify/,
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
        fees,
        defaults,
      ),
    /numeric/,
  );
});

test("SQLite preferences are owner/server isolated and active Marketplace slots are capped", () => {
  const store = new Store(":memory:");
  try {
    store.saveDefaults("alice", "guild", defaults);
    assert.deepEqual(store.defaults("alice", "guild"), defaults);
    assert.equal(store.defaults("bob", "guild"), null);
    assert.equal(store.defaults("alice", "other"), null);
    const config = prepare().config;
    const ids = Array.from({ length: 10 }, (_, n) =>
      store.createWatch(`user${n}`, "guild", config),
    );
    assert.throws(
      () => store.createWatch("alice", "guild", config),
      /Maximum 10/,
    );
    store.setActive(ids[0]!, "user0", "guild", false);
    store.createWatch("alice", "guild", config);
    assert.throws(
      () => store.setActive(ids[0]!, "user0", "guild", true),
      /Maximum 10/,
    );
    store.setActive(ids[1]!, "user1", "guild", false);
    assert.throws(
      () =>
        store.createWatch("alice", "guild", { ...config, intervalMinutes: 60 }),
      /1440/,
    );
  } finally {
    store.close();
  }
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

test("PostgreSQL migration enforces default privacy, global slots and daily cadence", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    for (const file of [
      "202609170001_scout.sql",
      "202609240001_classifieds.sql",
      "202609240002_preferences.sql",
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
  } finally {
    await db.close();
  }
});
