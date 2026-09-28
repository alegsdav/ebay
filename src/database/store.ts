import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError } from "../connectors/http.js";
import { randomUUID } from "node:crypto";
import { UserDefaults } from "../config/preferences.js";
import {
  Comparable,
  Listing,
  Normalized,
  WatchConfig,
  type Watch,
} from "../config/schema.js";

type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS watch_configs(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, guild_id TEXT NOT NULL, config TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, last_run INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_defaults(owner_id TEXT NOT NULL, guild_id TEXT NOT NULL, config TEXT NOT NULL, PRIMARY KEY(owner_id,guild_id));
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, guild_id TEXT NOT NULL, config TEXT NOT NULL, query TEXT NOT NULL, watch_id TEXT, revision INTEGER, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manual_submissions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, guild_id TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manual_evaluations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, guild_id TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY, data TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS normalized_items(listing_id TEXT NOT NULL REFERENCES listings(id), category TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(listing_id,category));
      CREATE TABLE IF NOT EXISTS processing(listing_id TEXT NOT NULL REFERENCES listings(id), watch_id TEXT NOT NULL REFERENCES watch_configs(id) ON DELETE CASCADE, status TEXT NOT NULL, details TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(listing_id,watch_id));
      CREATE TABLE IF NOT EXISTS comparables(id TEXT PRIMARY KEY, source_url TEXT NOT NULL UNIQUE, category TEXT NOT NULL, sale_date TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS comps_category_date ON comparables(category,sale_date);
      CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id), watch_id TEXT NOT NULL REFERENCES watch_configs(id) ON DELETE CASCADE, payload TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL, UNIQUE(listing_id,watch_id));
      CREATE TABLE IF NOT EXISTS feedback(alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE, user_id TEXT NOT NULL, action TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(alert_id,user_id));
      CREATE TABLE IF NOT EXISTS usage(service TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(service,day));
      CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    for (const event of ["INSERT", "UPDATE"])
      this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS marketplace_limit_${event.toLowerCase()} BEFORE ${event} ON watch_configs
      WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM json_each(NEW.config,'$.sources') WHERE value='facebook_marketplace')
      BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM watch_configs w WHERE w.active=1 AND w.id<>NEW.id AND EXISTS(SELECT 1 FROM json_each(w.config,'$.sources') WHERE value='facebook_marketplace'))>=10
          THEN RAISE(ABORT,'Maximum 10 active Marketplace watches. Pause or delete one first.') END;
        SELECT CASE WHEN coalesce(json_extract(NEW.config,'$.intervalMinutes'),0)<1440 THEN RAISE(ABORT,'Marketplace watches require at least 1440 minutes between searches.') END;
      END;
    `);
    this.db
      .prepare("DELETE FROM manual_submissions WHERE expires_at<=?")
      .run(Date.now());
    this.db
      .prepare("DELETE FROM manual_evaluations WHERE expires_at<=?")
      .run(Date.now());
  }
  close() {
    this.db.close();
  }
  defaults(owner: string, guild: string) {
    const row = this.db
      .prepare(
        "SELECT config FROM user_defaults WHERE owner_id=? AND guild_id=?",
      )
      .get(owner, guild);
    return row ? UserDefaults.parse(JSON.parse(String(row.config))) : null;
  }
  saveDefaults(owner: string, guild: string, value: UserDefaults) {
    this.db
      .prepare(
        "INSERT INTO user_defaults VALUES(?,?,?) ON CONFLICT(owner_id,guild_id) DO UPDATE SET config=excluded.config",
      )
      .run(owner, guild, JSON.stringify(UserDefaults.parse(value)));
  }
  createSubmission(owner: string, guild: string, data: unknown) {
    this.db
      .prepare("DELETE FROM manual_evaluations WHERE expires_at<=?")
      .run(Date.now());
    this.db
      .prepare("DELETE FROM manual_submissions WHERE expires_at<=?")
      .run(Date.now());
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO manual_submissions VALUES(?,?,?,?,?)")
      .run(id, owner, guild, JSON.stringify(data), Date.now() + 15 * 60000);
    return id;
  }
  consumeSubmission(id: string, owner: string, guild: string) {
    const row = this.db
      .prepare(
        "DELETE FROM manual_submissions WHERE id=? AND owner_id=? AND guild_id=? AND expires_at>? RETURNING data",
      )
      .get(id, owner, guild, Date.now());
    if (!row)
      throw new Error(
        "Evaluation preview expired, already used or not owned by you.",
      );
    return JSON.parse(String(row.data));
  }
  saveEvaluation(id: string, owner: string, guild: string, data: unknown) {
    this.db
      .prepare("INSERT INTO manual_evaluations VALUES(?,?,?,?,?)")
      .run(id, owner, guild, JSON.stringify(data), Date.now() + 30 * 86400000);
  }
  manualEvaluation(id: string, owner: string, guild: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM manual_evaluations WHERE id=? AND owner_id=? AND guild_id=? AND expires_at>?",
      )
      .get(id, owner, guild, Date.now());
    return row ? JSON.parse(String(row.data)) : null;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  decodeWatch(r: Row): Watch {
    return {
      id: r.id,
      ownerId: r.owner_id,
      guildId: r.guild_id,
      config: WatchConfig.parse(JSON.parse(r.config)),
      active: !!r.active,
      revision: r.revision,
      lastRun: r.last_run,
    };
  }
  watches(ownerId?: string, guildId?: string): Watch[] {
    const rows =
      ownerId && guildId
        ? this.db
            .prepare(
              "SELECT * FROM watch_configs WHERE owner_id=? AND guild_id=?",
            )
            .all(ownerId, guildId)
        : this.db.prepare("SELECT * FROM watch_configs").all();
    return rows.map((r) => this.decodeWatch(r));
  }
  watch(id: string, ownerId?: string, guildId?: string) {
    const r = this.db.prepare("SELECT * FROM watch_configs WHERE id=?").get(id);
    if (!r) return null;
    const w = this.decodeWatch(r);
    if (
      (ownerId && w.ownerId !== ownerId) ||
      (guildId && w.guildId !== guildId)
    )
      return null;
    return w;
  }
  createWatch(ownerId: string, guildId: string, config: WatchConfig) {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO watch_configs(id,owner_id,guild_id,config,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        ownerId,
        guildId,
        JSON.stringify(WatchConfig.parse(config)),
        now,
        now,
      );
    return id;
  }
  setActive(id: string, ownerId: string, guildId: string, active: boolean) {
    return (
      this.db
        .prepare(
          "UPDATE watch_configs SET active=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND guild_id=?",
        )
        .run(+active, Date.now(), id, ownerId, guildId).changes > 0
    );
  }
  deleteWatch(id: string, ownerId: string, guildId: string) {
    return (
      this.db
        .prepare(
          "DELETE FROM watch_configs WHERE id=? AND owner_id=? AND guild_id=?",
        )
        .run(id, ownerId, guildId).changes > 0
    );
  }
  due(w: Watch, now = Date.now()) {
    return w.active && now - w.lastRun >= w.config.intervalMinutes * 60000;
  }
  markRun(id: string) {
    this.db
      .prepare("UPDATE watch_configs SET last_run=? WHERE id=?")
      .run(Date.now(), id);
  }
  draft(
    ownerId: string,
    guildId: string,
    config: WatchConfig,
    query: string,
    watch?: Watch,
  ) {
    const id = randomUUID();
    this.db.prepare("DELETE FROM drafts WHERE expires_at<?").run(Date.now());
    this.db
      .prepare("INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        ownerId,
        guildId,
        JSON.stringify(config),
        query,
        watch?.id ?? null,
        watch?.revision ?? null,
        Date.now() + 15 * 60000,
      );
    return id;
  }
  getDraft(id: string, ownerId: string, guildId: string): Row {
    const r = this.db
      .prepare(
        "SELECT * FROM drafts WHERE id=? AND owner_id=? AND guild_id=? AND expires_at>?",
      )
      .get(id, ownerId, guildId, Date.now());
    if (!r)
      throw new Error(
        "Preview expired or belongs to another user. Create a new preview.",
      );
    return r;
  }
  cancelDraft(id: string, ownerId: string, guildId: string) {
    this.getDraft(id, ownerId, guildId);
    this.db.prepare("DELETE FROM drafts WHERE id=?").run(id);
  }
  confirmDraft(id: string, ownerId: string, guildId: string) {
    return this.transaction(() => {
      const r = this.getDraft(id, ownerId, guildId);
      let watchId = r.watch_id;
      if (watchId) {
        const result = this.db
          .prepare(
            "UPDATE watch_configs SET config=?,revision=revision+1,updated_at=?,last_run=0 WHERE id=? AND owner_id=? AND guild_id=? AND revision=?",
          )
          .run(r.config, Date.now(), watchId, ownerId, guildId, r.revision);
        if (!result.changes)
          throw new Error(
            "Watch changed since preview. Create a fresh update.",
          );
      } else
        watchId = this.createWatch(
          ownerId,
          guildId,
          WatchConfig.parse(JSON.parse(r.config)),
        );
      this.db.prepare("DELETE FROM drafts WHERE id=?").run(id);
      return watchId as string;
    });
  }
  saveListing(l: Listing) {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO listings VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,last_seen=excluded.last_seen",
      )
      .run(l.id, JSON.stringify(l), now, now);
  }
  listing(id: string) {
    const r = this.db.prepare("SELECT data FROM listings WHERE id=?").get(id);
    return r ? Listing.parse(JSON.parse(r.data as string)) : null;
  }
  normalized(id: string, category: string, hash: string) {
    const r = this.db
      .prepare(
        "SELECT data FROM normalized_items WHERE listing_id=? AND category=? AND hash=?",
      )
      .get(id, category, hash);
    return r ? Normalized.parse(JSON.parse(r.data as string)) : null;
  }
  saveNormalized(
    id: string,
    category: string,
    hash: string,
    data: Normalized,
    model: string,
    prompt: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO normalized_items VALUES(?,?,?,?,?,?,?) ON CONFLICT(listing_id,category) DO UPDATE SET hash=excluded.hash,data=excluded.data,model=excluded.model,prompt_version=excluded.prompt_version,created_at=excluded.created_at",
      )
      .run(id, category, hash, JSON.stringify(data), model, prompt, Date.now());
  }
  process(id: string, watchId: string, status: string, details: unknown) {
    this.db
      .prepare(
        "INSERT INTO processing VALUES(?,?,?,?,?) ON CONFLICT(listing_id,watch_id) DO UPDATE SET status=excluded.status,details=excluded.details,updated_at=excluded.updated_at",
      )
      .run(id, watchId, status, JSON.stringify(details), Date.now());
  }
  importComparables(input: unknown, now = Date.now()) {
    const rows = Comparable.array().min(1).max(10000).parse(input);
    for (const r of rows)
      if (
        Date.parse(r.saleDate) > now ||
        Date.parse(r.retrievedAt) > now ||
        Date.parse(r.retrievedAt) < Date.parse(r.saleDate)
      )
        throw new Error(
          "Comparable dates must describe a past sale retrieved after it sold.",
        );
    return this.transaction(() => {
      let changes = 0;
      for (const c of rows)
        changes += Number(
          this.db
            .prepare(
              "INSERT INTO comparables VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
            )
            .run(
              `${c.source}:${c.id}`,
              new URL(c.sourceUrl).origin + new URL(c.sourceUrl).pathname,
              c.category,
              c.saleDate,
              JSON.stringify(c),
            ).changes,
        );
      return changes;
    });
  }
  trackedListings(watchId: string, limit = 100) {
    return this.db
      .prepare(
        "SELECT l.data FROM listings l JOIN processing p ON l.id=p.listing_id LEFT JOIN alerts a ON a.listing_id=l.id AND a.watch_id=p.watch_id WHERE p.watch_id=? AND p.status NOT IN ('filtered','unavailable') AND a.id IS NULL ORDER BY p.updated_at ASC LIMIT ?",
      )
      .all(watchId, limit)
      .map((r) => Listing.parse(JSON.parse(r.data as string)));
  }
  comparables(category: string) {
    return this.db
      .prepare("SELECT data FROM comparables WHERE category=?")
      .all(category)
      .map((r) => Comparable.parse(JSON.parse(r.data as string)));
  }
  reserveAlert(listingId: string, watchId: string, payload: unknown) {
    const id = randomUUID();
    const result = this.db
      .prepare(
        "INSERT INTO alerts VALUES(?,?,?,?,?,?,?) ON CONFLICT(listing_id,watch_id) DO NOTHING",
      )
      .run(
        id,
        listingId,
        watchId,
        JSON.stringify(payload),
        "sending",
        null,
        Date.now(),
      );
    return result.changes ? id : null;
  }
  finishAlert(id: string, status: string, messageId: string | null = null) {
    this.db
      .prepare("UPDATE alerts SET status=?,message_id=? WHERE id=?")
      .run(status, messageId, id);
  }
  alert(id: string): Row | null {
    return (
      this.db
        .prepare(
          "SELECT a.*,w.owner_id,w.guild_id FROM alerts a JOIN watch_configs w ON w.id=a.watch_id WHERE a.id=?",
        )
        .get(id) ?? null
    );
  }
  feedback(id: string, userId: string, guildId: string, action: string) {
    const a = this.alert(id);
    if (!a || a.owner_id !== userId || a.guild_id !== guildId)
      throw new Error("Alert not found or not owned by you.");
    this.db
      .prepare(
        "INSERT INTO feedback VALUES(?,?,?,?) ON CONFLICT(alert_id,user_id) DO UPDATE SET action=excluded.action,updated_at=excluded.updated_at",
      )
      .run(id, userId, action, Date.now());
  }
  stats(ownerId: string, guildId: string) {
    const scalar = (sql: string) =>
      this.db.prepare(sql).get(ownerId, guildId)?.n ?? 0;
    return {
      watches: scalar(
        "SELECT COUNT(*) n FROM watch_configs WHERE owner_id=? AND guild_id=?",
      ),
      alerts: scalar(
        "SELECT COUNT(*) n FROM alerts a JOIN watch_configs w ON w.id=a.watch_id WHERE w.owner_id=? AND w.guild_id=?",
      ),
      needsProcessing: scalar(
        "SELECT COUNT(*) n FROM processing p JOIN watch_configs w ON w.id=p.watch_id WHERE w.owner_id=? AND w.guild_id=? AND p.status='needs_processing'",
      ),
    };
  }
  savedAlerts(ownerId: string, guildId: string) {
    return this.db
      .prepare(
        "SELECT a.id,a.payload,a.message_id FROM alerts a JOIN feedback f ON f.alert_id=a.id JOIN watch_configs w ON w.id=a.watch_id WHERE f.user_id=? AND w.owner_id=? AND w.guild_id=? AND f.action='saved' ORDER BY f.updated_at DESC",
      )
      .all(ownerId, ownerId, guildId)
      .map((r) => ({
        id: r.id,
        messageId: r.message_id,
        payload: JSON.parse(r.payload as string),
      }));
  }
  consumeBudget(service: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    this.transaction(() => {
      const count = Number(
        this.db
          .prepare("SELECT calls FROM usage WHERE service=? AND day=?")
          .get(service, day)?.calls ?? 0,
      );
      if (count >= limit)
        throw new HttpError(
          429,
          Date.parse(day + "T00:00:00.000Z") + 86400000,
          service,
        );
      this.db
        .prepare(
          "INSERT INTO usage VALUES(?,?,1) ON CONFLICT(service,day) DO UPDATE SET calls=calls+1",
        )
        .run(service, day);
    });
  }
  acquireLock(name: string) {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM locks WHERE expires_at<?").run(Date.now());
      const token = randomUUID();
      const r = this.db
        .prepare("INSERT INTO locks VALUES(?,?,?) ON CONFLICT DO NOTHING")
        .run(name, token, Date.now() + 50 * 60000);
      return r.changes ? token : null;
    });
  }
  releaseLock(name: string, token: string) {
    this.db
      .prepare("DELETE FROM locks WHERE name=? AND token=?")
      .run(name, token);
  }
}
