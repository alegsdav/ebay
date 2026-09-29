import type { Listing, WatchConfig } from "../config/schema.js";

export interface ListingSource {
  search(watch: WatchConfig): AsyncIterable<Listing>;
  detail?(listing: Listing): Promise<Listing>;
}
