import type { Listing, WatchConfig } from "../config/schema.js";

// Canonical pipeline data keeps the existing eBay field names for compatibility.
export type SourceListing = Listing;
export type AccessMode =
  "authorized_api" | "licensed_provider" | "user_submitted";
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
  readonly source: Listing["source"];
  readonly provider: string;
  readonly accessMode: AccessMode;
  capabilities(): SourceCapabilities;
  validateWatch(watch: WatchConfig): void;
}
// No licensed provider is registered until its data rights and live contract are reviewed.
export function assertSourceAccess(
  source: string,
  provider: string,
  mode: string,
  enabled: boolean,
) {
  if (
    !enabled ||
    ![
      "ebay:ebay:authorized_api",
      "facebook_marketplace:manual:user_submitted",
    ].includes(`${source}:${provider}:${mode}`)
  )
    throw new Error(
      "Source is disabled or its provider/access mode is not registered.",
    );
}
export function validateScheduledWatch(w: WatchConfig) {
  if ((w.sources ?? ["ebay"]).some((s) => s !== "ebay"))
    throw new Error(
      "Marketplace discovery is pending the Bright Data connection. Saved criteria are retained; no manual listing submission is required.",
    );
}
