import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/database/store.js";
import { Pipeline } from "../src/scheduler/pipeline.js";
import {
  listing,
  normalized,
  watch,
  parsed,
  comparableFixtures,
} from "../src/fixtures.js";
const interpreter = {
  model: "fixture",
  async parseWatch() {
    return parsed;
  },
  async normalize() {
    return normalized;
  },
};
test("draft ownership, expiry, cancellation, confirmation and stale-update conflicts", () => {
  const store = new Store(":memory:");
  try {
    const id = store.draft("alice", "guild", watch, "query");
    assert.throws(() => store.confirmDraft(id, "bob", "guild"));
    assert.throws(() => store.confirmDraft(id, "alice", "other"));
    const watchId = store.confirmDraft(id, "alice", "guild");
    assert.ok(store.watch(watchId));
    assert.throws(() => store.confirmDraft(id, "alice", "guild"));
    const w = store.watch(watchId)!;
    const draft = store.draft(
      "alice",
      "guild",
      { ...watch, name: "Edited" },
      "query",
      w,
    );
    store.setActive(watchId, "alice", "guild", false);
    assert.throws(() => store.confirmDraft(draft, "alice", "guild"), /changed/);
    const cancelled = store.draft("alice", "guild", watch, "query");
    store.cancelDraft(cancelled, "alice", "guild");
    assert.throws(() => store.getDraft(cancelled, "alice", "guild"));
    const expired = store.draft("alice", "guild", watch, "query");
    store.db.prepare("UPDATE drafts SET expires_at=0 WHERE id=?").run(expired);
    assert.throws(() => store.confirmDraft(expired, "alice", "guild"));
  } finally {
    store.close();
  }
});
test("successful watch update is atomic and preserves pause state", () => {
  const s = new Store(":memory:");
  try {
    const id = s.createWatch("alice", "g", watch);
    s.setActive(id, "alice", "g", false);
    const w = s.watch(id)!;
    const draft = s.draft(
      "alice",
      "g",
      { ...watch, name: "New name" },
      "new",
      w,
    );
    s.confirmDraft(draft, "alice", "g");
    assert.equal(s.watch(id)!.config.name, "New name");
    assert.equal(s.watch(id)!.active, false);
  } finally {
    s.close();
  }
});
test("pipeline normalizes once, re-evaluates prices, suppresses duplicate sends across runs", async () => {
  const store = new Store(":memory:");
  let calls = 0,
    sends = 0;
  let price = 50;
  try {
    store.createWatch("alice", "guild", watch);
    store.importComparables(comparableFixtures());
    const p = new Pipeline(
      store,
      {
        async *search() {
          yield { ...listing, price };
        },
      },
      {
        ...interpreter,
        async normalize() {
          calls++;
          return normalized;
        },
      },
      {
        async send() {
          sends++;
          return "message";
        },
      },
      { dryRun: false, maxLlmCalls: 10 },
    );
    await p.run(true);
    price = 45;
    await p.run(true);
    assert.equal(calls, 1);
    assert.equal(sends, 1);
    assert.equal(store.listing(listing.id)!.price, 45);
    const a = store.db.prepare("SELECT id FROM alerts").get()!;
    assert.throws(() =>
      store.feedback(a.id as string, "bob", "guild", "dismissed"),
    );
    store.feedback(a.id as string, "alice", "guild", "dismissed");
    assert.equal(
      store.db.prepare("SELECT action FROM feedback").get()!.action,
      "dismissed",
    );
  } finally {
    store.close();
  }
});
test("dry-run does not reserve notifications or delay later live scan", async () => {
  const s = new Store(":memory:");
  let sends = 0;
  try {
    const id = s.createWatch("a", "g", watch);
    s.importComparables(comparableFixtures());
    const source = {
      async *search() {
        yield listing;
      },
    };
    const sink = {
      async send() {
        sends++;
        return "message";
      },
    };
    await new Pipeline(s, source, interpreter, sink, {
      dryRun: true,
      maxLlmCalls: 5,
    }).run();
    assert.equal(s.watch(id)!.lastRun, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM alerts").get()!.n, 0);
    await new Pipeline(s, source, interpreter, sink, {
      dryRun: false,
      maxLlmCalls: 5,
    }).run();
    assert.equal(sends, 1);
  } finally {
    s.close();
  }
});
test("LLM failures remain retryable; a failed normalization does not poison dedup", async () => {
  const s = new Store(":memory:");
  let attempts = 0;
  try {
    s.createWatch("a", "g", watch);
    s.importComparables(comparableFixtures());
    const p = new Pipeline(
      s,
      {
        async *search() {
          yield listing;
        },
      },
      {
        ...interpreter,
        async normalize() {
          if (++attempts === 1) throw new SyntaxError("malformed");
          return normalized;
        },
      },
      {
        async send() {
          return "message";
        },
      },
      { dryRun: false, maxLlmCalls: 5 },
    );
    await p.run(true);
    assert.equal(
      s.db.prepare("SELECT status FROM processing").get()!.status,
      "needs_processing",
    );
    await p.run(true);
    assert.equal(attempts, 2);
    assert.equal(
      s.db.prepare("SELECT status FROM alerts").get()!.status,
      "sent",
    );
  } finally {
    s.close();
  }
});
test("unknown delivery never blindly retries; reservations survive restarted pipeline", async () => {
  const s = new Store(":memory:");
  let attempts = 0;
  try {
    s.createWatch("a", "g", watch);
    s.importComparables(comparableFixtures());
    const sink = {
      async send() {
        attempts++;
        throw new Error("connection lost after send");
      },
    };
    const source = {
      async *search() {
        yield listing;
      },
    };
    await new Pipeline(s, source, interpreter, sink, {
      dryRun: false,
      maxLlmCalls: 5,
    }).run(true);
    await new Pipeline(s, source, interpreter, sink, {
      dryRun: false,
      maxLlmCalls: 5,
    }).run(true);
    assert.equal(attempts, 1);
    assert.equal(
      s.db.prepare("SELECT status FROM alerts").get()!.status,
      "delivery_unknown",
    );
  } finally {
    s.close();
  }
});
test("import rejects invented evidence/future sales and deduplicates tracking links", () => {
  const s = new Store(":memory:");
  try {
    const rows = comparableFixtures();
    assert.equal(s.importComparables(rows), 5);
    assert.equal(s.importComparables(rows), 0);
    assert.equal(
      s.importComparables([
        {
          ...rows[0]!,
          id: "other",
          sourceUrl: rows[0]!.sourceUrl + "?tracking=1",
        },
      ]),
      0,
    );
    assert.throws(() =>
      s.importComparables([
        { ...rows[0], saleDate: "2099-01-01T00:00:00.000Z" },
      ]),
    );
    assert.throws(() =>
      s.importComparables([{ ...rows[0], evidence: "asking_price" }]),
    );
  } finally {
    s.close();
  }
});
test("database lease prevents overlapping scans", () => {
  const s = new Store(":memory:");
  try {
    const lock = s.acquireLock("scan")!;
    assert.equal(s.acquireLock("scan"), null);
    s.releaseLock("scan", "wrong");
    assert.equal(s.acquireLock("scan"), null);
    s.releaseLock("scan", lock);
    assert.ok(s.acquireLock("scan"));
  } finally {
    s.close();
  }
});
test("call budget persists pending records without alerting", async () => {
  const s = new Store(":memory:");
  try {
    s.createWatch("a", "g", watch);
    s.importComparables(comparableFixtures());
    await new Pipeline(
      s,
      {
        async *search() {
          yield listing;
          yield { ...listing, id: "second" };
        },
      },
      interpreter,
      {
        async send() {
          return "message";
        },
      },
      { dryRun: false, maxLlmCalls: 1 },
    ).run(true);
    assert.equal(
      s.db
        .prepare(
          "SELECT COUNT(*) n FROM processing WHERE status='needs_processing'",
        )
        .get()!.n,
      1,
    );
  } finally {
    s.close();
  }
});

test("persistent daily budget blocks calls even when a new consumer starts", () => {
  const s = new Store(":memory:");
  try {
    s.consumeBudget("llm", 2);
    s.consumeBudget("llm", 2);
    assert.throws(() => s.consumeBudget("llm", 2), /HTTP 429/);
    s.consumeBudget("ebay", 2);
    assert.equal(
      s.db.prepare("SELECT calls FROM usage WHERE service='llm'").get()!.calls,
      2,
    );
  } finally {
    s.close();
  }
});

test("previously silent listing is refreshed after leaving the newest results", async () => {
  const s = new Store(":memory:");
  let searchCount = 0;
  let sends = 0;
  let price = 70;
  try {
    s.createWatch("a", "g", watch);
    s.importComparables(comparableFixtures());
    const source = {
      async *search() {
        if (searchCount++ === 0) yield { ...listing, price };
      },
      async detail() {
        return { ...listing, price };
      },
    };
    const pipeline = new Pipeline(
      s,
      source,
      interpreter,
      {
        async send() {
          sends++;
          return "message";
        },
      },
      { dryRun: false, maxLlmCalls: 5 },
    );
    await pipeline.run(true);
    assert.equal(sends, 0);
    price = 50;
    await pipeline.run(true);
    assert.equal(sends, 1);
  } finally {
    s.close();
  }
});
