/**
 * Persistent inbox — boot recovery.
 *
 * Scans the queue dir at plugin startup, partitions each batch into one
 * of six buckets, and fans out follow-up work via the scheduler. The
 * scheduler does the actual timer management + re-read-before-fire +
 * processBatch routing; recovery just decides the right `delayMs` per
 * batch.
 *
 * MUST be called from `registerFull` BEFORE `api.registerHttpRoute(...)`
 * so no inbound webhook can race with the partition pass. Returns the
 * partition summary synchronously after fan-out; the scheduled work
 * proceeds on its own timers afterward.
 */

import { logMessageProcessed } from "openclaw/plugin-sdk/text-runtime";
import type { BatchRef, InboxQueue } from "./queue.js";
import type { RetryScheduler } from "./scheduler.js";
import { listBatches, type InboxQueuePaths } from "./store.js";
import {
  AGENT_RUN_TIMEOUT_MS,
  DELIVERY_BACKOFF_MS,
  DISPATCH_BACKOFF_MS,
  REPLAY_STAGGER_MS,
  REPLAY_TTL_MS,
  type InboxBatch,
  type Timestamp,
} from "./types.js";

export type BootRecoverySummary = {
  total: number;
  eligibleReceived: number;
  eligibleReplyReady: number;
  notYetEligibleReceived: number;
  deferred: number;
  expired: number;
  corrupt: number;
};

export type RunBootRecoveryDeps = {
  paths: InboxQueuePaths;
  queue: InboxQueue;
  scheduler: RetryScheduler;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
  /** Test seam — default `Date.now`. */
  now?: () => Timestamp;
};

export async function runBootRecovery(
  deps: RunBootRecoveryDeps,
): Promise<BootRecoverySummary> {
  const { paths, queue, scheduler, logger } = deps;
  const now = deps.now ?? (() => Date.now());

  const summary: BootRecoverySummary = {
    total: 0,
    eligibleReceived: 0,
    eligibleReplyReady: 0,
    notYetEligibleReceived: 0,
    deferred: 0,
    expired: 0,
    corrupt: 0,
  };

  const batches = await listBatches(paths, {
    onCorrupt: (file, err) => {
      summary.corrupt += 1;
      logger.error(
        `[odoo] inbox.recovery corrupt file=${file}: ${formatError(err)}`,
      );
    },
  });
  summary.total = batches.length;

  const tNow = now();
  const eligibleReceived: InboxBatch[] = [];

  for (let batch of batches) {
    const ref: BatchRef = {
      model: batch.model,
      res_id: batch.res_id,
      batchKey: batch.batchKey,
    };

    // 1. Expire any non-reply_ready batch older than 1h. Covers both
    //    "received" (never dispatched, or in backoff) and "dispatching"
    //    (previous process crashed mid-dispatch and the batch is just old).
    if (
      batch.state !== "reply_ready" &&
      tNow - batch.enqueuedAt > REPLAY_TTL_MS
    ) {
      await queue.moveBatchToFailed(ref);
      summary.expired += 1;
      // Telemetry: TTL-expired terminal failure. Distinct `reason` from the
      // scheduler's cap_exhausted path so dashboards can split the two.
      logMessageProcessed({
        channel: "odoo",
        sessionKey: `odoo:${batch.model}:${batch.res_id}`,
        outcome: "error",
        reason: "ttl_expired",
        durationMs: tNow - batch.enqueuedAt,
      });
      logger.error(
        `[odoo] inbox.recovery expired batchKey=${batch.batchKey} ` +
          `enqueuedAt=${batch.enqueuedAt} ageMs=${tNow - batch.enqueuedAt}`,
      );
      continue;
    }

    // 2. reply_ready always fires immediately — no stagger, no backoff,
    //    no TTL. Spec: "faster delivery is strictly better."
    if (batch.state === "reply_ready") {
      scheduler.scheduleAt(batch, 0);
      summary.eligibleReplyReady += 1;
      continue;
    }

    // 3. "dispatching" batches: either the previous process is presumed
    //    still running this dispatch (fresh `inFlightSince` → defer until
    //    the staleness boundary), or the previous process died holding
    //    the in-flight marker (stale → normalize back to "received" with
    //    a bumped dispatchAttempts counter, then fall through).
    if (batch.state === "dispatching") {
      if (
        batch.inFlightSince !== null &&
        tNow - batch.inFlightSince < AGENT_RUN_TIMEOUT_MS
      ) {
        const delay = batch.inFlightSince + AGENT_RUN_TIMEOUT_MS - tNow;
        scheduler.scheduleAt(batch, delay);
        summary.deferred += 1;
        continue;
      }
      // Stale. recordFailure flips state back to "received" and bumps
      // dispatchAttempts — gives crash-recovery a real counter so the
      // gateway-flapping loop is bounded by DISPATCH_MAX_ATTEMPTS.
      const normalized = await queue.recordFailure(
        ref,
        "internal_error",
        new Error(
          "dispatch aborted by process crash (stale dispatching marker)",
        ),
      );
      if (!normalized) continue; // file vanished mid-loop
      batch = normalized; // re-bind for the remainder of this iteration
      logger.info(
        `[odoo] inbox.recovery normalized stale dispatching batchKey=${batch.batchKey} ` +
          `dispatchAttempts=${batch.dispatchAttempts}`,
      );
      // fall through to the "received" path below
    }

    // From here, state === "received" (either originally, or after
    // normalization above).

    // 4. Backoff still active from a prior failure recorded on disk?
    const eligibleAt = nextEligibleAt(batch);
    if (eligibleAt !== null && eligibleAt > tNow) {
      scheduler.scheduleAt(batch, eligibleAt - tNow);
      summary.notYetEligibleReceived += 1;
      continue;
    }

    // 5. Eligible immediately — collect for the stagger pass.
    eligibleReceived.push(batch);
  }

  // 6. Stagger immediately-eligible received batches at REPLAY_STAGGER_MS
  //    cadence so we don't dogpile the agent concurrency lane on boot.
  for (let i = 0; i < eligibleReceived.length; i += 1) {
    scheduler.scheduleAt(eligibleReceived[i], i * REPLAY_STAGGER_MS);
    summary.eligibleReceived += 1;
  }

  logger.info(
    `[odoo] inbox.recovery total=${summary.total} ` +
      `eligibleReceived=${summary.eligibleReceived} ` +
      `replyReady=${summary.eligibleReplyReady} ` +
      `notYetEligible=${summary.notYetEligibleReceived} ` +
      `deferred=${summary.deferred} expired=${summary.expired} ` +
      `corrupt=${summary.corrupt}`,
  );

  return summary;
}

/**
 * If the batch has a recorded failure, return the wall-clock at which the
 * next retry becomes eligible (`lastAttemptAt + backoff[counter - 1]`).
 * Returns null if there's no recorded failure — meaning eligible
 * immediately. Reply_ready batches go through a different bucket and
 * never call this function.
 */
function nextEligibleAt(batch: InboxBatch): Timestamp | null {
  if (batch.lastAttemptAt === null || batch.lastFailureClass === null) {
    return null;
  }
  const counter =
    batch.lastFailureClass === "xmlrpc_failure"
      ? batch.deliveryAttempts
      : batch.dispatchAttempts;
  const table =
    batch.lastFailureClass === "xmlrpc_failure"
      ? DELIVERY_BACKOFF_MS
      : DISPATCH_BACKOFF_MS;
  const idx = Math.min(counter - 1, table.length - 1);
  return batch.lastAttemptAt + table[idx];
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
