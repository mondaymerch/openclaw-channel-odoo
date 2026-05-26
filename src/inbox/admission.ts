/**
 * Dispatch admission control for the persistent inbox.
 *
 * The inbox is durable, but durability alone does not protect the OpenClaw
 * process: without a gate, many received batches can still start agent runs at
 * once after debounce/recovery. This controller keeps the drain rate bounded.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import type { InboxBatch } from "./types.js";

export type AdmissionTicket = {
  release: () => void;
};

export type AdmissionDecision =
  | { ok: true; ticket: AdmissionTicket }
  | { ok: false; reason: string; retryMs: number };

export type AdmissionController = {
  tryAcquire: (batch: InboxBatch) => AdmissionDecision;
  snapshot: () => {
    activeDispatches: number;
    maxConcurrentDispatches: number;
    lastDispatchStartedAt: number;
  };
};

export type DispatchAdmissionOptions = {
  maxConcurrentDispatches: number;
  retryDelayMs: number;
  minDispatchSpacingMs: number;
  maxProcessRssMb: number;
  maxEventLoopDelayMs: number;
  now?: () => number;
};

export function createDispatchAdmissionController(
  opts: DispatchAdmissionOptions,
): AdmissionController {
  const maxConcurrentDispatches = Math.max(1, opts.maxConcurrentDispatches);
  const retryDelayMs = Math.max(250, opts.retryDelayMs);
  const minDispatchSpacingMs = Math.max(0, opts.minDispatchSpacingMs);
  const maxProcessRssBytes = Math.max(0, opts.maxProcessRssMb) * 1024 * 1024;
  const maxEventLoopDelayMs = Math.max(0, opts.maxEventLoopDelayMs);
  const now = opts.now ?? (() => Date.now());

  let activeDispatches = 0;
  let lastDispatchStartedAt = 0;

  const eventLoop =
    maxEventLoopDelayMs > 0 ? monitorEventLoopDelay({ resolution: 20 }) : null;
  eventLoop?.enable();

  return {
    tryAcquire(_batch) {
      const tNow = now();

      if (activeDispatches >= maxConcurrentDispatches) {
        return {
          ok: false,
          reason: `concurrency_${activeDispatches}_ge_${maxConcurrentDispatches}`,
          retryMs: retryDelayMs,
        };
      }

      if (minDispatchSpacingMs > 0 && lastDispatchStartedAt > 0) {
        const remaining = minDispatchSpacingMs - (tNow - lastDispatchStartedAt);
        if (remaining > 0) {
          return {
            ok: false,
            reason: `spacing_${remaining}ms`,
            retryMs: Math.max(remaining, retryDelayMs),
          };
        }
      }

      if (maxProcessRssBytes > 0) {
        const rssBytes = process.memoryUsage().rss;
        if (rssBytes >= maxProcessRssBytes) {
          return {
            ok: false,
            reason:
              `rss_mb_${Math.round(rssBytes / 1024 / 1024)}` +
              `_ge_${Math.round(maxProcessRssBytes / 1024 / 1024)}`,
            retryMs: retryDelayMs,
          };
        }
      }

      if (eventLoop && maxEventLoopDelayMs > 0) {
        const p99Ms = eventLoop.percentile(99) / 1_000_000;
        if (p99Ms >= maxEventLoopDelayMs) {
          return {
            ok: false,
            reason: `event_loop_p99_ms_${Math.round(p99Ms)}_ge_${maxEventLoopDelayMs}`,
            retryMs: retryDelayMs,
          };
        }
      }

      activeDispatches += 1;
      lastDispatchStartedAt = tNow;
      let released = false;
      return {
        ok: true,
        ticket: {
          release: () => {
            if (released) return;
            released = true;
            activeDispatches = Math.max(0, activeDispatches - 1);
          },
        },
      };
    },

    snapshot() {
      return {
        activeDispatches,
        maxConcurrentDispatches,
        lastDispatchStartedAt,
      };
    },
  };
}
