import { Listing, type WatchConfig } from "../config/schema.js";
import type { Env } from "../config/env.js";
import { redact } from "../privacy.js";
import { requestJson } from "./http.js";
import {
  assertSourceAccess,
  type ListingSourceConnector,
  type SourceListing,
} from "./source.js";

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
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
    title: evidence.title,
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
// Stub: the Bright Data keyword-search request/response contract is not captured yet
// (see docs/bright-data-setup.md). FACEBOOK_MONITORING_ENABLED defaults false, and the
// worker skips this source per watch while it is off.
export class BrightDataSource implements ListingSourceConnector {
  readonly source = "facebook_marketplace";
  readonly provider = "brightdata";
  readonly accessMode = "licensed_provider";
  constructor(
    private env: Env,
    private budget?: () => void | Promise<void>,
    private signal?: AbortSignal,
  ) {}
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
    if (!watch.location)
      throw new Error("Marketplace searches require a city/postal area.");
  }
  // Its own service name keeps Bright Data budgets and 429 cooldowns separate from eBay/LLM.
  protected request(url: string, init: RequestInit = {}) {
    return requestJson(
      url,
      { ...init, signal: this.signal },
      "brightdata",
      this.budget,
    );
  }
  async *search(watch: WatchConfig): AsyncIterable<SourceListing> {
    this.validateWatch(watch);
    throw new NotImplementedError("Bright Data connector not yet implemented.");
  }
  async detail(_listing: SourceListing): Promise<SourceListing> {
    throw new NotImplementedError("Bright Data connector not yet implemented.");
  }
}
