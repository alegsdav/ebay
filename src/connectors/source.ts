import type { Listing, WatchConfig } from "../config/schema.js";

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
// Disabled sources are skipped per watch so the remaining legs still run.
export function scheduledSources(
  w: WatchConfig,
  flags: { facebook: boolean },
): SourcePlan {
  const plan: SourcePlan = { scan: [], skipped: [] };
  for (const source of w.sources) {
    if (source === "facebook_marketplace" && !flags.facebook)
      plan.skipped.push({ source, reason: "facebook_monitoring_disabled" });
    else if (source === "facebook_marketplace" && !w.location)
      plan.skipped.push({ source, reason: "missing_location" });
    else plan.scan.push(source);
  }
  return plan;
}
