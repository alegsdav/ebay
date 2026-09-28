import { Listing, type WatchConfig } from "../config/schema.js";
import { type Env, requireValues } from "../config/env.js";
import { marketplaceCity } from "../config/preferences.js";
import { redact } from "../privacy.js";
import { requestJson } from "./http.js";
import { assertSourceAccess, type SnapshotSourceConnector } from "./source.js";

export function marketplaceIdentity(value: string) {
  const url = new URL(value);
  const match = /^\/marketplace\/item\/(\d+)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(
      url.hostname,
    ) ||
    !match
  )
    throw new Error("Expected an HTTPS Facebook Marketplace item URL.");
  const externalId = match[1]!;
  return {
    externalId,
    url: `https://www.facebook.com/marketplace/item/${externalId}/`,
  };
}
export interface MarketplaceFacts {
  url: string;
  title: string;
  description?: string;
  price: number;
  condition?: Listing["condition"];
  locationLabel?: string | null;
  deliveryModes?: ("pickup" | "shipping")[];
  status?: NonNullable<Listing["provenance"]>["status"];
  listedAt?: string | null;
  raw?: unknown;
}
// Provider records become canonical listings here: canonical URL/ID, redacted
// seller-typed text, and provenance with an evidence hash. No seller identity is kept.
export async function marketplaceListing(
  facts: MarketplaceFacts,
  retrievedAt = new Date(),
): Promise<Listing> {
  const { externalId, url } = marketplaceIdentity(facts.url);
  const evidence = {
    title: redact(facts.title),
    description: redact(facts.description ?? ""),
    price: facts.price,
    condition: facts.condition ?? "unknown",
    location: facts.locationLabel ? redact(facts.locationLabel) : null,
  };
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(evidence)),
  );
  return Listing.parse({
    id: `facebook_marketplace:brightdata:${externalId}`,
    source: "facebook_marketplace",
    url,
    title: evidence.title.slice(0, 500),
    description: evidence.description.slice(0, 20000),
    specifics: [],
    price: evidence.price,
    shipping: null,
    currency: "USD",
    condition: evidence.condition,
    sellerName: "unknown",
    sellerPercent: null,
    sellerFeedback: null,
    country: null,
    auction: false,
    endTime: null,
    listedAt: facts.listedAt ?? null,
    raw: facts.raw ?? null,
    provenance: {
      provider: "brightdata",
      accessMode: "licensed_provider",
      externalId,
      retrievedAt: retrievedAt.toISOString(),
      schemaVersion: "1",
      evidenceHash: Array.from(new Uint8Array(hash), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join(""),
      locationLabel: evidence.location,
      deliveryModes: facts.deliveryModes?.length
        ? facts.deliveryModes
        : ["pickup"],
      travelCost: 0,
      status: facts.status ?? "unknown",
    },
  });
}
// Facebook shows "New", "Used - Like New", "Used - Good", "Used - Fair".
export function marketplaceCondition(value: unknown): Listing["condition"] {
  const c = String(value ?? "").toLowerCase();
  if (/refurb/.test(c)) return "refurbished";
  if (/parts|salvage|not working/.test(c)) return "for_parts";
  if (/^new\b/.test(c)) return "new";
  if (/used/.test(c)) return "used";
  return "unknown";
}
const isoDate = (value: unknown) => {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
// One Bright Data "Facebook Marketplace listings" record. Seller profile IDs,
// images and videos are deliberately not kept.
export async function mapBrightDataRecord(r: any, retrievedAt = new Date()) {
  const price = Number(r?.final_price ?? r?.initial_price);
  if (r?.currency !== "USD" || !Number.isFinite(price))
    throw new Error("Missing price or unsupported currency");
  return marketplaceListing(
    {
      url: String(r.url),
      title: String(r.title ?? ""),
      description: String(r.description ?? r.seller_description ?? ""),
      price,
      condition: marketplaceCondition(r.condition),
      locationLabel: typeof r.location === "string" ? r.location : null,
      status: r.is_sold === true ? "sold" : "active",
      listedAt: isoDate(r.listing_date),
      raw: {
        productId: r.product_id ?? null,
        listingDate: r.listing_date ?? null,
        condition: r.condition ?? null,
        initialPrice: r.initial_price ?? null,
        finalPrice: r.final_price ?? null,
        rootCategory: r.root_category ?? null,
      },
    },
    retrievedAt,
  );
}
const states: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
// Live tests: "Campbell, CA" was not recognized (results fell back to Virginia),
// while "Campbell, California" returned Bay Area listings. Send full state names.
export function providerCity(location: NonNullable<WatchConfig["location"]>) {
  const city = marketplaceCity(location);
  if (!city) return null;
  const m = /^(.*),\s*([A-Z]{2})$/.exec(city);
  return m && states[m[2]!] ? `${m[1]}, ${states[m[2]!]}` : city;
}
export type SnapshotStatus =
  "starting" | "running" | "ready" | "failed" | "canceled";
// Bright Data keyword discovery is asynchronous (1–6 minutes per search): the worker
// triggers a snapshot, then collects it on a later run. Billing is per returned record.
export class BrightDataSource implements SnapshotSourceConnector {
  readonly source = "facebook_marketplace";
  readonly provider = "brightdata";
  readonly accessMode = "licensed_provider";
  private base = "https://api.brightdata.com/datasets/v3";
  constructor(
    private env: Env,
    private budget?: () => void | Promise<void>,
    private signal?: AbortSignal,
  ) {
    requireValues(env, ["BRIGHT_DATA_API_KEY"]);
  }
  capabilities() {
    return {
      scheduledSearch: true,
      locations: true,
      deliveryModes: ["pickup", "shipping"] as const,
    };
  }
  validateWatch(watch: WatchConfig) {
    assertSourceAccess(
      this.source,
      this.provider,
      this.accessMode,
      this.env.FACEBOOK_MONITORING_ENABLED,
    );
    if (!watch.sources.includes(this.source))
      throw new Error("Watch does not include Facebook Marketplace.");
    if (!watch.location || !marketplaceCity(watch.location))
      throw new Error("Marketplace searches require a city (City, ST).");
  }
  // Its own service name keeps Bright Data budgets and 429 cooldowns separate from eBay/LLM.
  private request(path: string, init: RequestInit = {}, attempts = 3) {
    return requestJson(
      `${this.base}${path}`,
      {
        ...init,
        signal: this.signal,
        headers: {
          Authorization: `Bearer ${this.env.BRIGHT_DATA_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
      "brightdata",
      this.budget,
      attempts,
    );
  }
  async trigger(
    watch: WatchConfig,
    opts: { limit: number; recentOnly: boolean },
  ) {
    this.validateWatch(watch);
    const query = new URLSearchParams({
      dataset_id: this.env.BRIGHT_DATA_DATASET_ID,
      type: "discover_new",
      discover_by: "keyword",
      include_errors: "true",
      limit_per_input: String(opts.limit),
    });
    const data = await this.request(
      `/trigger?${query}`,
      {
        method: "POST",
        body: JSON.stringify({
          input: [
            {
              keyword: watch.searchTerms,
              city: providerCity(watch.location!),
              radius: watch.location!.radiusMiles,
              date_listed: opts.recentOnly
                ? this.env.BRIGHT_DATA_RECENT_FILTER
                : "",
            },
          ],
        }),
      },
      1,
    );
    const id = data?.snapshot_id;
    if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id))
      throw new Error("Bright Data did not return a snapshot ID");
    return id;
  }
  async progress(id: string): Promise<SnapshotStatus> {
    const data = await this.request(`/progress/${encodeURIComponent(id)}`);
    const status = data?.status;
    if (
      !["starting", "running", "ready", "failed", "canceled"].includes(status)
    )
      throw new Error("Unexpected Bright Data snapshot status");
    return status;
  }
  async download(id: string) {
    const data = await this.request(
      `/snapshot/${encodeURIComponent(id)}?format=json`,
    );
    if (!Array.isArray(data))
      throw new Error("Bright Data snapshot is not ready or not a list");
    const listings: Listing[] = [];
    let errors = 0,
      rejected = 0;
    const now = new Date();
    for (const r of data) {
      if (r?.error || r?.error_code) {
        errors++;
        continue;
      }
      try {
        listings.push(await mapBrightDataRecord(r, now));
      } catch {
        rejected++;
      }
    }
    return { listings, received: data.length - errors, errors, rejected };
  }
}
