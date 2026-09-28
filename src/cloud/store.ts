import { Normalized, WatchConfig, type Listing } from "../config/schema.js";
import { HttpError } from "../connectors/http.js";
import { UserDefaults } from "../config/preferences.js";
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
  kind: "interaction" | "scan" | "listing" | "snapshot";
  payload: any;
  lease_token: string;
  attempts: number;
}
export class CloudStore {
  async defaults(owner: string, guild: string) {
    const row = (
      await this.rows("scout_user_defaults", {
        owner_id: `eq.${owner}`,
        guild_id: `eq.${guild}`,
      })
    )[0];
    return row ? UserDefaults.parse(row.config) : null;
  }
  async saveDefaults(owner: string, guild: string, config: UserDefaults) {
    await this.upsert(
      "scout_user_defaults",
      { owner_id: owner, guild_id: guild, config: UserDefaults.parse(config) },
      "owner_id,guild_id",
    );
  }
  sourceConfigs() {
    return this.rows("scout_source_configs");
  }
  startIngestion(sourceConfigId: string, watchId: string) {
    return this.insert("scout_ingestion_runs", {
      source_config_id: sourceConfigId,
      watch_id: watchId,
      status: "running",
    });
  }
  takeSourceBudget(configId: string, costUnits: number) {
    if (!Number.isFinite(costUnits) || costUnits < 0)
      throw new Error("Invalid provider cost");
    return this.rpc("scout_take_source_budget", {
      p_config: configId,
      p_cost: costUnits,
    });
  }
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
          "Maximum 5 active Marketplace watches. Pause or delete one first.",
          "Marketplace watches require at least 60 minutes between searches.",
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
  // Reserve (positive) or refund (negative) units against a calendar-month cap.
  async monthlyBudget(service: string, amount: number, limit: number) {
    return (await this.rpc("scout_take_monthly_budget", {
      p_service: service,
      p_amount: amount,
      p_limit: limit,
    })) as boolean;
  }
  // Listings this watch already processed, so repeats skip extraction and alerts.
  async seen(watch: string, listings: string[]) {
    if (!listings.length) return new Set<string>();
    const rows = await this.rows("scout_processing", {
      watch_id: `eq.${watch}`,
      listing_id: `in.(${listings.map((id) => `"${id.replace(/["\\]/g, "")}"`).join(",")})`,
      select: "listing_id",
    });
    return new Set(rows.map((r) => String(r.listing_id)));
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
