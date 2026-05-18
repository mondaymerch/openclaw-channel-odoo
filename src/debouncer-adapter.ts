/**
 * Debouncer → persistent inbox adapter.
 *
 * Bridges the in-memory `createInboundDebouncer` (from openclaw plugin-sdk)
 * to the disk-backed `processBatch`. The webhook handler has already
 * persisted each inbound message via `queue.appendOrCreateBatch`, so by
 * the time the debouncer's `onFlush` fires, the durable batch exists on
 * disk. The adapter just looks it up and hands it to `processBatch`.
 *
 * If the lookup returns null, the batch was moved between webhook ACK and
 * debouncer flush — possible if a scheduler-retry or a parallel processor
 * already handled it. Log + skip.
 */

import type { InboundMessage } from "./dispatch.js";
import type { InboxBatch } from "./inbox/types.js";
import { findOpenBatchForRecord, type InboxQueuePaths } from "./inbox/store.js";

export type CreateDebouncerAdapterDeps = {
  paths: InboxQueuePaths;
  processBatch: (batch: InboxBatch) => Promise<void>;
  logger: { info: (m: string) => void; error: (m: string) => void };
};

export function createDebouncerAdapter(
  deps: CreateDebouncerAdapterDeps,
): (items: InboundMessage[]) => Promise<void> {
  const { paths, processBatch, logger } = deps;
  return async (items) => {
    if (items.length === 0) return;
    const last = items[items.length - 1];
    const routingKey = last.routing_key ?? null;
    const batch = await findOpenBatchForRecord(
      paths,
      last.model,
      last.res_id,
      routingKey,
    );
    if (!batch) {
      logger.info(
        `[odoo] debouncer.onFlush: no open batch for ${last.model},${last.res_id}` +
          `${routingKey !== null ? `,${routingKey}` : ""} ` +
          `(${items.length} buffered items — likely already dispatched)`,
      );
      return;
    }
    await processBatch(batch);
  };
}
