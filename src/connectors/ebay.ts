import { Listing, type WatchConfig } from "../config/schema.js";
import { type Env, requireValues } from "../config/env.js";
import { HttpError, requestJson } from "./http.js";
import { log } from "../logging.js";
import type { ListingSource } from "./source.js";
export type { ListingSource } from "./source.js";
export function mapCondition(id: unknown): Listing["condition"] {
  const n = Number(id);
  if (n === 1000) return "new";
  if (n === 1500) return "open_box";
  if ([2000, 2010, 2020, 2030, 2500].includes(n)) return "refurbished";
  if ([3000, 4000, 5000, 6000].includes(n)) return "used";
  if (n === 7000) return "for_parts";
  return "unknown";
}
const isoDate = (value: unknown) => {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
export function mapItem(item: any): Listing {
  if (
    item.estimatedAvailabilities?.some((a: any) =>
      ["OUT_OF_STOCK", "TEMPORARILY_UNAVAILABLE"].includes(
        a.estimatedAvailabilityStatus,
      ),
    )
  )
    throw new Error("Listing unavailable");
  const auction = item.buyingOptions?.includes("AUCTION") ?? false;
  // Never substitute a buy-it-now price for an unknown current auction bid.
  const price = auction ? item.currentBidPrice : item.price;
  if (!price || price.currency !== "USD")
    throw new Error("Missing price or unsupported currency");
  const shippingOptions = item.shippingOptions ?? [];
  const shipping = shippingOptions
    .filter(
      (s: any) =>
        s.shippingCost?.currency === "USD" &&
        s.shippingCost?.value !== undefined,
    )
    .map((s: any) => Number(s.shippingCost.value))
    .filter((n: number) => Number.isFinite(n) && n >= 0);
  return Listing.parse({
    id: item.itemId,
    source: "ebay",
    url: item.itemWebUrl,
    title: item.title,
    description: String(item.description ?? item.shortDescription ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 20000),
    specifics: (item.localizedAspects ?? []).map((a: any) => ({
      key: a.name,
      value: a.value,
    })),
    price: Number(price.value),
    shipping: shipping.length ? Math.min(...shipping) : null,
    currency: "USD",
    condition: mapCondition(item.conditionId),
    sellerName: item.seller?.username ?? "unknown",
    sellerPercent:
      item.seller?.feedbackPercentage != null
        ? Number(item.seller.feedbackPercentage)
        : null,
    sellerFeedback:
      item.seller?.feedbackScore != null
        ? Number(item.seller.feedbackScore)
        : null,
    country: item.itemLocation?.country ?? null,
    auction,
    endTime: item.itemEndDate ?? null,
    listedAt: isoDate(item.itemCreationDate),
    // Store useful source evidence, excluding response metadata, account/payment fields and exact locations.
    raw: {
      itemId: item.itemId,
      title: item.title,
      price: item.price,
      currentBidPrice: item.currentBidPrice,
      condition: item.condition,
      conditionId: item.conditionId,
      buyingOptions: item.buyingOptions,
      shippingOptions: item.shippingOptions,
      localizedAspects: item.localizedAspects,
    },
  });
}
export class EbaySource implements ListingSource {
  private token = "";
  private expires = 0;
  private base: string;
  constructor(
    private env: Env,
    private budget?: () => void | Promise<void>,
    private signal?: AbortSignal,
  ) {
    requireValues(env, [
      "EBAY_CLIENT_ID",
      "EBAY_CLIENT_SECRET",
      "EBAY_POSTAL_CODE",
    ]);
    this.base =
      env.EBAY_ENV === "production"
        ? "https://api.ebay.com"
        : "https://api.sandbox.ebay.com";
  }
  private async accessToken() {
    if (this.expires > Date.now()) return this.token;
    const data = await requestJson(
      `${this.base}/identity/v1/oauth2/token`,
      {
        method: "POST",
        signal: this.signal,
        headers: {
          Authorization: `Basic ${btoa(`${this.env.EBAY_CLIENT_ID}:${this.env.EBAY_CLIENT_SECRET}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "https://api.ebay.com/oauth/api_scope",
        }).toString(),
      },
      "ebay",
      this.budget,
    );
    if (!data.access_token) throw new Error("Missing eBay access token");
    this.token = data.access_token;
    this.expires = Date.now() + (Number(data.expires_in) - 60) * 1000;
    return this.token;
  }
  private async get(path: string): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestJson(
          `${this.base}${path}`,
          {
            signal: this.signal,
            headers: {
              Authorization: `Bearer ${await this.accessToken()}`,
              "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
              "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${this.env.EBAY_POSTAL_CODE}`,
            },
          },
          "ebay",
          this.budget,
        );
      } catch (e) {
        if (e instanceof HttpError && e.status === 401 && attempt === 0) {
          this.expires = 0;
          continue;
        }
        throw e;
      }
    }
  }
  async *search(watch: WatchConfig) {
    if (watch.buying !== "fixed" && !this.env.EBAY_ALLOW_AUCTIONS)
      throw new Error(
        "Auction access is disabled; update watch to fixed or enable approved auction access.",
      );
    const buying =
      watch.buying === "fixed"
        ? "FIXED_PRICE"
        : watch.buying === "auction"
          ? "AUCTION"
          : "FIXED_PRICE|AUCTION";
    const seen = new Set<string>();
    for (let page = 0; page < this.env.MAX_PAGES_PER_WATCH; page++) {
      const query = new URLSearchParams({
        q: watch.searchTerms,
        filter: `buyingOptions:{${buying}},itemLocationCountry:US,deliveryCountry:US`,
        sort: "newlyListed",
        limit: "50",
        offset: String(page * 50),
      });
      const response = await this.get(
        `/buy/browse/v1/item_summary/search?${query}`,
      );
      for (const summary of response.itemSummaries ?? []) {
        if (seen.has(summary.itemId)) continue;
        seen.add(summary.itemId);
        try {
          yield mapItem(summary);
        } catch {
          log("listing_rejected", {
            reason: "invalid_or_unsupported_source_data",
          });
        }
      }
      if (!response.next) break;
      if (page === this.env.MAX_PAGES_PER_WATCH - 1)
        log("search_truncated", {
          pages: this.env.MAX_PAGES_PER_WATCH,
        });
    }
  }
  async detail(listing: Listing): Promise<Listing> {
    if (listing.source !== "ebay") throw new Error("Source mismatch");
    const data = await this.get(
      `/buy/browse/v1/item/${encodeURIComponent(listing.id)}`,
    );
    return mapItem(data);
  }
}
