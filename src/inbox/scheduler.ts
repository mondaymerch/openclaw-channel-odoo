/**
 * Persistent inbox — in-memory retry scheduler.
 *
 * Owns the cap policy (DISPATCH_MAX_ATTEMPTS, DELIVERY_MAX_ATTEMPTS),
 * backoff timing, and the per-batchKey timer map. Composes the queue
 * facade's primitives: on a fresh failure, calls `recordFailure`, then
 * either `moveBatchToFailed` (cap hit) or schedules the next retry.
 *
 * On retry fire, re-reads the batch file from disk (race-safe — file may
 * have been unlinked by a concurrent path) and hands the fresh batch to
 * the injected `processBatch` callback. The callback knows how to
 * re-dispatch a `received` batch vs re-deliver a `reply_ready` batch.
 *
 * No fallback chatter post — that's a per-channel concern handled outside
 * this module. When a batch is abandoned, the scheduler just logs.
 */

import type { BatchRef, InboxQueue } from "./queue.js";
import { readBatch, type InboxQueuePaths } from "./store.js";
import {
  DELIVERY_BACKOFF_MS,
  DELIVERY_MAX_ATTEMPTS,
  DISPATCH_BACKOFF_MS,
  DISPATCH_MAX_ATTEMPTS,
  type FailureClass,
  type InboxBatch,
} from "./types.js";

// ---- Public types --------------------------------------------------------

export type ProcessBatchFn = (batch: InboxBatch) => Promise<void>;

export type RetryScheduler = {
  /**
   * Called by the dispatch flow on a fresh failure. Records via the facade,
   * then either moves the batch to failed/ (cap hit) or schedules the next
   * retry. No-op if the file is missing (race).
   */
  handleFailure(
    ref: BatchRef,
    failureClass: FailureClass,
    err: unknown,
  ): Promise<void>;

  /**
   * Called by boot recovery for batches with pre-existing failure state
   * whose backoff window hasn't elapsed. Skips `recordFailure`, just sets
   * the timer for `delayMs` from now. Cancels any existing timer for the
   * same batchKey first.
   */
  scheduleAt(batch: InboxBatch, delayMs: number): void;

  /** Cancel all in-flight timers. For clean plugin shutdown / reload. */
  cancelAll(): void;
};

export type CreateRetrySchedulerDeps = {
  paths: InboxQueuePaths;
  queue: InboxQueue;
  /**
   * Called when a scheduled retry fires. Implementer inspects `batch.state`
   * and runs the appropriate path (re-dispatch for "received", re-deliver
   * XML-RPC for "reply_ready"). Throwing is treated as a bug — the
   * implementer should record failures via the facade itself.
   */
  processBatch: ProcessBatchFn;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** Test seam — default `setTimeout`. */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  /** Test seam — default `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
};

// ---- Decision function (private) -----------------------------------------

type NextAction =
  | { kind: "retry"; delayMs: number }
  | { kind: "abandon" };

function nextAction(batch: InboxBatch, failureClass: FailureClass): NextAction {
  if (failureClass === "xmlrpc_failure") {
    if (batch.deliveryAttempts >= DELIVERY_MAX_ATTEMPTS) return { kind: "abandon" };
    return { kind: "retry", delayMs: DELIVERY_BACKOFF_MS[batch.deliveryAttempts - 1] };
  }
  // silent | internal_error → dispatchAttempts
  if (batch.dispatchAttempts >= DISPATCH_MAX_ATTEMPTS) return { kind: "abandon" };
  return { kind: "retry", delayMs: DISPATCH_BACKOFF_MS[batch.dispatchAttempts - 1] };
}

// ---- Factory -------------------------------------------------------------

export function createRetryScheduler(deps: CreateRetrySchedulerDeps): RetryScheduler {
  const { paths, queue, processBatch, logger } = deps;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const timers = new Map<string, unknown>();

  function cancel(batchKey: string): void {
    const t = timers.get(batchKey);
    if (t !== undefined) {
      clearTimer(t);
      timers.delete(batchKey);
    }
  }

  async function fire(batchKey: string): Promise<void> {
    timers.delete(batchKey);
    const current = await readBatch(paths, batchKey);
    if (!current) return;   // race: file unlinked between schedule and fire
    try {
      await processBatch(current);
    } catch (err) {
      logger.error(
        `[odoo] inbox.fire processBatch threw batchKey=${batchKey}: ${formatError(err)}`,
      );
    }
  }

  function scheduleAt(batch: InboxBatch, delayMs: number): void {
    cancel(batch.batchKey);
    const t = setTimer(() => {
      void fire(batch.batchKey);
    }, Math.max(0, delayMs));
    // `.unref()` so this timer doesn't keep the process alive on shutdown.
    // Guard for fake timers in tests where the handle won't have it.
    if (t && typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
    timers.set(batch.batchKey, t);
    logger.info(
      `[odoo] inbox.retry scheduled batchKey=${batch.batchKey} delayMs=${delayMs}`,
    );
  }

  return {
    async handleFailure(ref, failureClass, err) {
      const updated = await queue.recordFailure(ref, failureClass, err);
      if (!updated) return;     // race: file gone

      const action = nextAction(updated, failureClass);
      if (action.kind === "abandon") {
        cancel(ref.batchKey);   // drop any stale timer
        await queue.moveBatchToFailed(ref);
        logger.error(
          `[odoo] inbox.abandoned batchKey=${ref.batchKey} class=${failureClass} ` +
            `dispatchAttempts=${updated.dispatchAttempts} ` +
            `deliveryAttempts=${updated.deliveryAttempts}`,
        );
        return;
      }
      scheduleAt(updated, action.delayMs);
    },

    scheduleAt,

    cancelAll() {
      for (const [, t] of timers) clearTimer(t);
      timers.clear();
    },
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
