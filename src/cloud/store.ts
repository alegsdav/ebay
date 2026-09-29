import { Normalized, WatchConfig, type Listing } from "../config/schema.js";
import { HttpError } from "../connectors/http.js";
export interface CloudWatch {
  id: string;
  owner_id: string;
  guild_id: string;
  config: WatchConfig;
  active: boolean;
  revision: number;
  next_scan_at: string;
}
export interface CloudDraft {
  id: string;
  owner_id: string;
  guild_id: string;
  config: WatchConfig;
  query: string;
  watch_id: string | null;
  revision: number | null;
  expires_at: string;
}
export interface Job {
  id: string;
  kind: "interaction" | "scan" | "listing";
  payload: any;
  lease_token: string;
  attempts: number;
}
export class CloudStore {
  constructor(
    private url: string,
    private key: string,
    private signal?: AbortSignal,
  ) {}
  async request(path: string, method = "GET", body?: unknown, prefer?: string) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      if (response.status === 400) {
        const error = await response.json().catch(() => null);
        const safeMessages = [
          "Watch changed; create a fresh preview",
          "Preview expired or unavailable",
        ];
        if (safeMessages.includes(error?.message))
          throw new Error(error.message);
      }
      throw new HttpError(response.status, 0, "supabase");
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  rpc(name: string, args: Record<string, unknown> = {}) {
    return this.request(`rpc/${name}`, "POST", args);
  }
  async rows(table: string, params: Record<string, string> = {}) {
    return (await this.request(
      `${table}?${new URLSearchParams(params)}`,
    )) as any[];
  }
  async insert(table: string, body: unknown, conflict?: string) {
    return (await this.request(
      table + (conflict ? `?on_conflict=${conflict}` : ""),
      "POST",
      body,
      `return=representation${conflict ? ",resolution=ignore-duplicates" : ""}`,
    )) as any[];
  }
  async upsert(table: string, body: unknown, conflict: string) {
    return this.request(
      `${table}?on_conflict=${conflict}`,
      "POST",
      body,
      "resolution=merge-duplicates,return=minimal",
    );
  }
  async update(table: string, params: Record<string, string>, body: unknown) {
    return this.request(
      `${table}?${new URLSearchParams(params)}`,
      "PATCH",
      body,
      "return=representation",
    );
  }
  async remove(table: string, params: Record<string, string>) {
    return this.request(`${table}?${new URLSearchParams(params)}`, "DELETE");
  }
  async watch(
    id: string,
    owner?: string,
    guild?: string,
  ): Promise<CloudWatch | null> {
    const row = (
      await this.rows("scout_watches", {
        id: `eq.${id}`,
        ...(owner ? { owner_id: `eq.${owner}` } : {}),
        ...(guild ? { guild_id: `eq.${guild}` } : {}),
      })
    )[0];
    return row ? { ...row, config: WatchConfig.parse(row.config) } : null;
  }
  async draft(id: string, owner: string, guild: string): Promise<CloudDraft> {
    const row = (
      await this.rows("scout_drafts", {
        id: `eq.${id}`,
        owner_id: `eq.${owner}`,
        guild_id: `eq.${guild}`,
        expires_at: `gt.${new Date().toISOString()}`,
      })
    )[0];
    if (!row)
      throw new Error(
        "Preview expired or not owned by you. Create a fresh preview.",
      );
    return { ...row, config: WatchConfig.parse(row.config) };
  }
  async createDraft(
    owner: string,
    guild: string,
    config: WatchConfig,
    query: string,
    interactionId: string,
    watch?: CloudWatch,
  ) {
    const rows = await this.insert(
      "scout_drafts",
      {
        owner_id: owner,
        guild_id: guild,
        config: WatchConfig.parse(config),
        query,
        interaction_id: interactionId,
        watch_id: watch?.id ?? null,
        revision: watch?.revision ?? null,
      },
      "interaction_id",
    );
    return (
      rows[0] ??
      (
        await this.rows("scout_drafts", {
          interaction_id: `eq.${interactionId}`,
        })
      )[0]
    );
  }
  async budget(service: string, limit: number) {
    if (
      !(await this.rpc("scout_take_budget", {
        p_service: service,
        p_limit: limit,
      }))
    ) {
      const rows = await this.rows("scout_cooldowns", {
        service: `eq.${service}`,
      });
      const midnight =
        Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z") +
        86400000;
      throw new HttpError(
        429,
        rows[0] && Date.parse(rows[0].until_at) > Date.now()
          ? Date.parse(rows[0].until_at)
          : midnight,
        service,
      );
    }
  }
  async cooldown(service: string, until: number) {
    await this.upsert(
      "scout_cooldowns",
      { service, until_at: new Date(until).toISOString() },
      "service",
    );
  }
  async enqueue(
    rows: {
      dedupe_key: string;
      kind: Job["kind"];
      payload: unknown;
      available_at?: string;
    }[],
  ) {
    if (rows.length) await this.insert("scout_jobs", rows, "dedupe_key");
  }
  async saveListing(l: Listing) {
    await this.upsert(
      "scout_listings",
      { id: l.id, data: l, last_seen_at: new Date().toISOString() },
      "id",
    );
  }
  async process(
    watch: string,
    listing: string,
    status: string,
    details: unknown,
  ) {
    await this.upsert(
      "scout_processing",
      {
        watch_id: watch,
        listing_id: listing,
        status,
        details,
        updated_at: new Date().toISOString(),
      },
      "watch_id,listing_id",
    );
  }
  // The hash covers listing evidence, model, prompt and the watch's search intent.
  async normalized(listing: string, hash: string) {
    const row = (
      await this.rows("scout_normalized", {
        listing_id: `eq.${listing}`,
        hash: `eq.${hash}`,
      })
    )[0];
    return row ? Normalized.parse(row.data) : null;
  }
}
