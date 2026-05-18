/**
 * Persistent inbox — consumer-facing facade.
 *
 * Composes `record-lock.ts` (per-record serialization) and `store.ts` (file
 * CRUD) into a small API the webhook handler, dispatch flow, retry
 * scheduler, and boot recovery talk to.
 *
 * The facade is a pure state-mutation surface. It does NOT enforce caps,
 * post fallback chatter, schedule retries, or trigger any side effects
 * beyond writing/moving/unlinking batch files. Policy lives in callers
 * (retry scheduler, boot recovery, dispatch wiring).
 *
 * All mutating methods take the per-record lock internally — callers don't
 * have to manage lock discipline.
 */

import { randomUUID } from "node:crypto";

import type { RecordLock } from "./record-lock.js";
import {
  findBatchContainingMessage,
  findOpenBatchForRecord,
  moveBatchToFailed as storeMoveBatchToFailed,
  mutateBatch,
  readBatch,
  unlinkBatch,
  writeBatch,
  type InboxQueuePaths,
} from "./store.js";
import type { FailureClass, InboxBatch, InboundMessage, Timestamp } from "./types.js";

// ---- Public types --------------------------------------------------------

export type CreateInboxQueueDeps = {
  paths: InboxQueuePaths;
  lock: RecordLock;
  /** Test seam: deterministic batchKey generator. Default: `randomUUID()`. */
  newBatchKey?: () => string;
  /** Test seam: clock override. Default: `Date.now`. */
  now?: () => Timestamp;
};

export type AppendOrCreateInput = {
  model: string;
  res_id: number;
  message_id: number;
  body: string;
  /** Optional. Together with model+res_id, identifies the batch lane.
   *  Two inbounds on the same record with different routing keys form
   *  separate batches; same-or-both-null share a batch. */
  routing_key?: string | null;
  user_name?: string;
  partner_id?: number;
};

export type AppendOrCreateResult =
  | { ok: true; batchKey: string; didCreate: boolean }
  | { ok: false; reason: "duplicate"; existingBatchKey: string }
  | { ok: false; reason: "disk_error"; error: unknown };

/**
 * Result of `markDispatching`. The CAS loser branch carries a `reason`
 * so callers can log meaningfully:
 *   - "missing"      — the batch file vanished (race with concurrent unlink)
 *   - "not_received" — the batch is in state "dispatching" or "reply_ready";
 *                      another caller is handling it
 */
export type MarkDispatchingResult =
  | { ok: true; batch: InboxBatch }
  | { ok: false; reason: "missing" | "not_received" };

/**
 * Identifies a specific batch. Carries model + res_id + routing_key so the
 * facade can compute the per-lane lock key without round-tripping to disk
 * first. `routing_key` is `undefined` on refs constructed before the field
 * existed (older tests, legacy callers) — treated equivalent to `null`.
 */
export type BatchRef = {
  model: string;
  res_id: number;
  batchKey: string;
  routing_key?: string | null;
};

export type InboxQueue = {
  /**
   * Append the inbound message to the currently-open batch for its record,
   * or create a fresh batch if none is open. Returns a typed result so the
   * caller (webhook handler) can map outcomes to HTTP statuses without
   * try/catch.
   *
   * Dedup: if `input.message_id` is already present in any batch on disk
   * (active OR failed), returns `{ ok: false, reason: "duplicate", ... }`
   * and does not write. This handles Odoo's webhook retry-on-timeout.
   *
   * Concurrency: holds `lock.withLock(\`${model}:${res_id}\`)` for the
   * whole dedup + lookup + write sequence, so concurrent webhooks for the
   * same record serialize cleanly.
   */
  appendOrCreateBatch(input: AppendOrCreateInput): Promise<AppendOrCreateResult>;

  /**
   * Atomic CAS: transition state `received` → `dispatching`, setting
   * `inFlightSince = now()` and (on the first call only) `closedAt = now()`.
   *
   * Returns `{ ok: true, batch }` on the winning transition, or
   * `{ ok: false, reason }` if another caller is already dispatching this
   * batch (`reason: "not_received"`) or the file vanished
   * (`reason: "missing"`).
   *
   * Called by dispatch.ts right before awaiting the agent run. The per-record
   * lock serializes the read-check-write sequence; the CAS prevents two
   * concurrent `processBatch` invocations on the same batchKey from both
   * running the agent and posting XML-RPC twice.
   */
  markDispatching(ref: BatchRef): Promise<MarkDispatchingResult>;

  /**
   * Transition state `dispatching` → `reply_ready`, populate
   * `reply.text` + `reply.producedAt = now()`, and clear `inFlightSince`.
   * Called inside the wrapped `deliver` callback BEFORE invoking the
   * XML-RPC `callReply`, so a crash mid-deliver leaves the agent's text
   * checkpointed on disk and recovery can re-attempt the post without
   * re-running the agent.
   *
   * Does NOT modify `closedAt` — that's the "ever dispatched" marker and
   * stays set forever.
   */
  transitionToReplyReady(ref: BatchRef, text: string): Promise<InboxBatch | null>;

  /**
   * XML-RPC `callReply` succeeded — unlink the batch file. Called inside
   * the deliver wrapper after `callReply` returns successfully.
   */
  recordDeliverySuccess(ref: BatchRef): Promise<void>;

  /**
   * Record a classified failure on the batch:
   *  - `silent` / `internal_error` → bump `dispatchAttempts`
   *  - `xmlrpc_failure` → bump `deliveryAttempts`
   *  - all classes set `lastFailureClass`, `lastError`, `lastAttemptAt`
   *  - if state was `dispatching`, flip back to `received` (re-opens the
   *    batch for backoff retry AND for appending new debounced messages)
   *  - always clears `inFlightSince` (the in-flight agent run is over)
   *
   * Returns the updated batch so the caller can inspect counters and
   * decide on cap-driven follow-up (move-to-failed + fallback post). Does
   * NOT enforce caps or trigger side effects.
   */
  recordFailure(
    ref: BatchRef,
    failureClass: FailureClass,
    error: unknown,
  ): Promise<InboxBatch | null>;

  /**
   * Move the batch from queueDir to failedDir. Called after observing
   * cap-exhaustion via `recordFailure`'s return value, OR by boot recovery
   * on TTL-expired received batches. ENOENT-safe (no-op if file gone).
   */
  moveBatchToFailed(ref: BatchRef): Promise<void>;
};

// ---- Factory -------------------------------------------------------------

export function createInboxQueue(deps: CreateInboxQueueDeps): InboxQueue {
  const { paths, lock } = deps;
  const newBatchKey = deps.newBatchKey ?? (() => randomUUID());
  const now = deps.now ?? (() => Date.now());

  const laneKey = (
    model: string,
    res_id: number,
    routing_key: string | null | undefined,
  ) => `${model}:${res_id}:${routing_key ?? ""}`;
  const refLaneKey = (ref: BatchRef) =>
    laneKey(ref.model, ref.res_id, ref.routing_key);

  return {
    async appendOrCreateBatch(input) {
      const recordKey = laneKey(input.model, input.res_id, input.routing_key);

      try {
        return await lock.withLock(recordKey, async () => {
          // 1. Dedup against disk (active queueDir + failedDir).
          const dup = await findBatchContainingMessage(paths, input.message_id);
          if (dup) {
            return {
              ok: false as const,
              reason: "duplicate" as const,
              existingBatchKey: dup.batchKey,
            };
          }

          // 2. Find currently-open batch for this record + routing-key lane.
          const routingKey = input.routing_key ?? null;
          const open = await findOpenBatchForRecord(
            paths,
            input.model,
            input.res_id,
            routingKey,
          );
          const t = now();
          const newMessage: InboundMessage = {
            message_id: input.message_id,
            body: input.body,
            user_name: input.user_name,
            partner_id: input.partner_id,
            receivedAt: t,
          };

          if (open) {
            // 3a. Append to the existing open batch.
            await mutateBatch(paths, open.batchKey, (b) => {
              b.messages.push(newMessage);
            });
            return {
              ok: true as const,
              batchKey: open.batchKey,
              didCreate: false,
            };
          }

          // 3b. No open batch — create a fresh one.
          const batchKey = newBatchKey();
          const batch: InboxBatch = {
            batchKey,
            state: "received",
            model: input.model,
            res_id: input.res_id,
            routing_key: routingKey,
            messages: [newMessage],
            enqueuedAt: t,
            closedAt: null,
            inFlightSince: null,
            dispatchAttempts: 0,
            deliveryAttempts: 0,
            lastAttemptAt: null,
            lastError: null,
            lastFailureClass: null,
            reply: null,
          };
          await writeBatch(paths, batch);
          return {
            ok: true as const,
            batchKey,
            didCreate: true,
          };
        });
      } catch (err) {
        // ENOENT / EACCES / EIO / disk full / parse errors during dedup
        // scan / etc. Webhook handler will translate this to 503.
        return { ok: false, reason: "disk_error", error: err };
      }
    },

    async markDispatching(ref) {
      return lock.withLock(refLaneKey(ref), async () => {
        // CAS: read first to check the precondition, write only if the
        // batch is in state "received". The lock serializes this entire
        // read-check-write sequence.
        const current = await readBatch(paths, ref.batchKey);
        if (!current) {
          return { ok: false as const, reason: "missing" as const };
        }
        if (current.state !== "received") {
          return { ok: false as const, reason: "not_received" as const };
        }
        const t = now();
        const updated = await mutateBatch(paths, ref.batchKey, (b) => {
          b.state = "dispatching";
          if (b.closedAt === null) b.closedAt = t;
          b.inFlightSince = t;
        });
        return updated
          ? { ok: true as const, batch: updated }
          : { ok: false as const, reason: "missing" as const };
      });
    },

    async transitionToReplyReady(ref, text) {
      const t = now();
      return lock.withLock(refLaneKey(ref), () =>
        mutateBatch(paths, ref.batchKey, (b) => {
          b.state = "reply_ready";
          b.reply = { text, producedAt: t };
          b.inFlightSince = null;
        }),
      );
    },

    async recordDeliverySuccess(ref) {
      await lock.withLock(refLaneKey(ref), () =>
        unlinkBatch(paths, ref.batchKey),
      );
    },

    async recordFailure(ref, failureClass, error) {
      const t = now();
      const message = formatError(error);
      return lock.withLock(refLaneKey(ref), () =>
        mutateBatch(paths, ref.batchKey, (b) => {
          b.lastFailureClass = failureClass;
          b.lastError = message;
          b.lastAttemptAt = t;
          if (failureClass === "xmlrpc_failure") {
            b.deliveryAttempts += 1;
          } else {
            b.dispatchAttempts += 1;
          }
          // End the in-flight agent run. If we were dispatching, re-open
          // the batch for backoff retry (state flips back to "received"
          // so findOpenBatchForRecord can append new messages too).
          // An xmlrpc_failure recorded inside deliver runs after
          // transitionToReplyReady, so state is already "reply_ready" —
          // the conditional below leaves it alone.
          if (b.state === "dispatching") {
            b.state = "received";
          }
          b.inFlightSince = null;
        }),
      );
    },

    async moveBatchToFailed(ref) {
      await lock.withLock(refLaneKey(ref), () =>
        storeMoveBatchToFailed(paths, ref.batchKey),
      );
    },
  };
}

/**
 * Best-effort error → string conversion for `lastError`.
 * - Error instance → `.message`
 * - string → unchanged
 * - plain object → JSON
 * - everything else (circular refs, non-serializable) → `String(err)`
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
