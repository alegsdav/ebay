import { createHash } from "node:crypto";
import { type ListingSource } from "../connectors/source.js";
import { type Interpreter, PROMPT_VERSION } from "../llm/client.js";
import { Store } from "../database/store.js";
import { basicReject } from "../filters/matches.js";
import { evaluate } from "../pricing/score.js";
import { type AlertPayload } from "../alerts/format.js";
import { log, errorKind } from "../logging.js";
import { HttpError } from "../connectors/http.js";
import type { Listing } from "../config/schema.js";
export interface AlertSink {
  send(channelId: string, payload: AlertPayload, id: string): Promise<string>;
}
export interface PipelineOptions {
  dryRun: boolean;
  maxLlmCalls: number;
}
export class Pipeline {
  constructor(
    private store: Store,
    private source: ListingSource & {
      detail?: (listing: Listing) => Promise<Listing>;
    },
    private llm: Interpreter,
    private sink: AlertSink,
    private options: PipelineOptions,
  ) {}
  private async *candidates(
    watchId: string,
    config: import("../config/schema.js").WatchConfig,
  ) {
    const seen = new Set<string>();
    // Revisit pending and previously silent listings even if absent from the newest search page.
    // A fresh detail request is mandatory for old data; fixture-only sources do not use this path.
    if (this.source.detail)
      for (const old of this.store.trackedListings(watchId)) {
        if (old.endTime && Date.parse(old.endTime) <= Date.now()) continue;
        seen.add(old.id);
        yield old;
      }
    for await (const listing of this.source.search(config)) {
      if (!seen.has(listing.id)) {
        seen.add(listing.id);
        yield listing;
      }
    }
  }
  async run(force = false) {
    const lock = this.store.acquireLock("scan");
    if (!lock) {
      log("scan_skipped", { reason: "another_scan_running" });
      return;
    }
    const started = Date.now();
    let llmCalls = 0;
    let found = 0;
    let alerts = 0;
    try {
      for (const w of this.store
        .watches()
        .filter((w) => w.active && (force || this.store.due(w)))) {
        if (Date.now() - started > 40 * 60000) {
          log("scan_budget_reached");
          break;
        }
        let complete = true;
        try {
          for await (let listing of this.candidates(w.id, w.config)) {
            if (Date.now() - started > 40 * 60000) {
              complete = false;
              break;
            }
            this.store.saveListing(listing);
            found++;
            try {
              const rejected = basicReject(listing, w.config);
              if (rejected) {
                this.store.process(listing.id, w.id, "filtered", {
                  reason: rejected,
                });
                continue;
              }
              // Fetch full item specifics only after cheap search-result filtering.
              if (this.source.detail) {
                listing = await this.source.detail(listing);
                this.store.saveListing(listing);
              }
              const hash = createHash("sha256")
                .update(
                  JSON.stringify({
                    title: listing.title,
                    description: listing.description,
                    specifics: listing.specifics,
                    condition: listing.condition,
                    model: this.llm.model,
                    prompt: PROMPT_VERSION,
                  }),
                )
                .digest("hex");
              let normalized = this.store.normalized(
                listing.id,
                w.config.category,
                hash,
              );
              if (!normalized) {
                if (llmCalls >= this.options.maxLlmCalls) {
                  complete = false;
                  this.store.process(listing.id, w.id, "needs_processing", {
                    reason: "LLM call budget reached",
                  });
                  continue;
                }
                llmCalls++;
                normalized = await this.llm.normalize(listing, w.config);
                if (normalized.confidence >= 0.65)
                  this.store.saveNormalized(
                    listing.id,
                    w.config.category,
                    hash,
                    normalized,
                    this.llm.model,
                    PROMPT_VERSION,
                  );
              }
              const evaluation = evaluate(
                listing,
                normalized,
                w.config,
                this.store.comparables(w.config.category),
              );
              this.store.process(listing.id, w.id, evaluation.tier, {
                evaluation,
              });
              const current = this.store.watch(w.id);
              if (
                !current ||
                !current.active ||
                current.revision !== w.revision
              ) {
                complete = false;
                break;
              }
              const channel =
                evaluation.tier === "strong"
                  ? w.config.channelId
                  : evaluation.tier === "possible"
                    ? w.config.possibleChannelId
                    : null;
              if (!channel) continue;
              const payload = {
                listing,
                normalized,
                evaluation,
                config: w.config,
              };
              if (this.options.dryRun) {
                log("dry_run_alert", {
                  watchId: w.id,
                  listingId: listing.id,
                  tier: evaluation.tier,
                  metrics: evaluation.metrics,
                });
                continue;
              }
              // Reserve before sending. Uncertain deliveries are held for manual reconciliation, never blindly resent.
              const alertId = this.store.reserveAlert(
                listing.id,
                w.id,
                payload,
              );
              if (!alertId) continue;
              try {
                const messageId = await this.sink.send(
                  channel,
                  payload,
                  alertId,
                );
                this.store.finishAlert(alertId, "sent", messageId);
                alerts++;
              } catch (error) {
                this.store.finishAlert(alertId, "delivery_unknown");
                log("alert_delivery_unknown", {
                  alertId,
                  error: errorKind(error),
                });
              }
            } catch (error) {
              complete = false;
              this.store.process(listing.id, w.id, "needs_processing", {
                error: errorKind(error),
                ...(error instanceof HttpError
                  ? {
                      status: error.status,
                      retryAt: error.retryAt,
                      service: error.service,
                    }
                  : {}),
              });
              log("listing_failure", {
                watchId: w.id,
                listingId: listing.id,
                error: errorKind(error),
              });
              if (
                error instanceof HttpError &&
                [404, 410].includes(error.status)
              )
                this.store.process(listing.id, w.id, "unavailable", {
                  reason: "Source listing removed",
                });
              if (error instanceof HttpError && error.status === 429) break;
            }
          }
          if (complete && !this.options.dryRun) this.store.markRun(w.id);
        } catch (error) {
          log("watch_scan_failure", {
            watchId: w.id,
            error: errorKind(error),
            ...(error instanceof HttpError
              ? { status: error.status, retryAt: error.retryAt }
              : {}),
          });
        }
      }
      log("scan_completed", {
        found,
        alerts,
        llmCalls,
        dryRun: this.options.dryRun,
      });
    } finally {
      this.store.releaseLock("scan", lock);
    }
  }
}
