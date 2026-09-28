import type { Listing, WatchConfig } from "../config/schema.js";
import { marketplaceCity } from "../config/preferences.js";

// Canonical pipeline data keeps the existing eBay field names for compatibility.
export type SourceListing = Listing;
export type SourceId = Listing["source"];
export type AccessMode = "authorized_api" | "licensed_provider";
export interface SourceCapabilities {
  scheduledSearch: boolean;
  locations: boolean;
  deliveryModes: readonly ("pickup" | "shipping")[];
}
export interface ListingSource {
  search(watch: WatchConfig): AsyncIterable<SourceListing>;
  detail?(listing: SourceListing): Promise<SourceListing>;
}
export interface ListingSourceConnector extends ListingSource {
  readonly source: SourceId;
  readonly provider: string;
  readonly accessMode: AccessMode;
  capabilities(): SourceCapabilities;
  validateWatch(watch: WatchConfig): void;
}
// Providers whose searches run as background jobs: trigger now, collect later.
export interface SnapshotSourceConnector {
  readonly source: SourceId;
  readonly provider: string;
  readonly accessMode: AccessMode;
  capabilities(): SourceCapabilities;
  validateWatch(watch: WatchConfig): void;
  trigger(
    watch: WatchConfig,
    opts: { limit: number; recentOnly: boolean },
  ): Promise<string>;
  progress(
    id: string,
  ): Promise<"starting" | "running" | "ready" | "failed" | "canceled">;
  download(id: string): Promise<{
    listings: SourceListing[];
    received: number;
    errors: number;
    rejected: number;
  }>;
}
// Only reviewed source/provider/access-mode triples may run, and only while enabled.
const registered = [
  "ebay:ebay:authorized_api",
  "facebook_marketplace:brightdata:licensed_provider",
];
export function assertSourceAccess(
  source: string,
  provider: string,
  mode: string,
  enabled: boolean,
) {
  if (!enabled || !registered.includes(`${source}:${provider}:${mode}`))
    throw new Error(
      "Source is disabled or its provider/access mode is not registered.",
    );
}
export interface SourcePlan {
  scan: SourceId[];
  skipped: { source: SourceId; reason: string }[];
}
// Disabled or unconfigured sources are skipped per watch so the remaining legs still run.
export function scheduledSources(
  w: WatchConfig,
  flags: { facebook: boolean; ebay?: boolean },
): SourcePlan {
  const plan: SourcePlan = { scan: [], skipped: [] };
  for (const source of w.sources) {
    if (source === "ebay" && flags.ebay === false)
      plan.skipped.push({ source, reason: "ebay_not_configured" });
    else if (source === "facebook_marketplace" && !flags.facebook)
      plan.skipped.push({ source, reason: "facebook_monitoring_disabled" });
    else if (
      source === "facebook_marketplace" &&
      (!w.location || !marketplaceCity(w.location))
    )
      plan.skipped.push({ source, reason: "missing_city" });
    else plan.scan.push(source);
  }
  return plan;
}
