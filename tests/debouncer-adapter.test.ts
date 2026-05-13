/**
 * Tests for src/debouncer-adapter.ts — createDebouncerAdapter.
 *
 * The adapter sits between the in-memory debouncer (which buffers
 * InboundMessage objects) and processBatch (which expects a persisted
 * InboxBatch). On flush it looks up the open batch on disk and hands it
 * to processBatch.
 *
 * Run: npx tsx --test tests/debouncer-adapter.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDebouncerAdapter } from "../src/debouncer-adapter.js";
import type { InboundMessage } from "../src/dispatch.js";
import {
  ensureInboxQueueDirs,
  resolveInboxQueuePaths,
  writeBatch,
} from "../src/inbox/store.js";
import type { InboxBatch } from "../src/inbox/types.js";

function makeLogger() {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    logger: {
      info: (m: string) => infos.push(m),
      error: (m: string) => errors.push(m),
    },
    infos,
    errors,
  };
}

function makeBatch(overrides: Partial<InboxBatch> & { batchKey: string }): InboxBatch {
  return {
    batchKey: overrides.batchKey,
    state: "received",
    model: "crm.lead",
    res_id: 42,
    messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
    enqueuedAt: 1000,
    closedAt: null,
    inFlightSince: null,
    dispatchAttempts: 0,
    deliveryAttempts: 0,
    lastAttemptAt: null,
    lastError: null,
    lastFailureClass: null,
    reply: null,
    ...overrides,
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "odoo-debouncer-adapter-"));
  const paths = resolveInboxQueuePaths(dir);
  await ensureInboxQueueDirs(paths);
  return { dir, paths };
}

// ============================================================
// E3-T1: open batch on disk → processBatch called with it
// ============================================================

test("E3-T1: open batch on disk → processBatch called with the batch", async () => {
  const { dir, paths } = await setup();
  try {
    const batch = makeBatch({ batchKey: "abc" });
    await writeBatch(paths, batch);

    const calls: InboxBatch[] = [];
    const { logger } = makeLogger();
    const adapter = createDebouncerAdapter({
      paths,
      processBatch: async (b) => {
        calls.push(b);
      },
      logger,
    });

    const items: InboundMessage[] = [
      { model: "crm.lead", res_id: 42, body: "hi", message_id: 1 },
    ];
    await adapter(items);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].batchKey, "abc");
    assert.equal(calls[0].model, "crm.lead");
    assert.equal(calls[0].res_id, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E3-T2: no batch on disk → adapter logs + no-op
// ============================================================

test("E3-T2: no batch on disk → adapter logs and skips processBatch", async () => {
  const { dir, paths } = await setup();
  try {
    const calls: InboxBatch[] = [];
    const { logger, infos } = makeLogger();
    const adapter = createDebouncerAdapter({
      paths,
      processBatch: async (b) => {
        calls.push(b);
      },
      logger,
    });

    const items: InboundMessage[] = [
      { model: "crm.lead", res_id: 999, body: "hi", message_id: 1 },
    ];
    await adapter(items);

    assert.equal(calls.length, 0);
    const note = infos.find((m) => m.includes("no open batch"));
    assert.ok(note);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E3-T3: multi-item buffer derives (model, res_id) from last item
// ============================================================

test("E3-T3: multi-item buffer looks up once, processBatch called once", async () => {
  const { dir, paths } = await setup();
  try {
    const batch = makeBatch({
      batchKey: "multi",
      messages: [
        { message_id: 1, body: "one", receivedAt: 1000 },
        { message_id: 2, body: "two", receivedAt: 1500 },
      ],
    });
    await writeBatch(paths, batch);

    const calls: InboxBatch[] = [];
    const { logger } = makeLogger();
    const adapter = createDebouncerAdapter({
      paths,
      processBatch: async (b) => {
        calls.push(b);
      },
      logger,
    });

    const items: InboundMessage[] = [
      { model: "crm.lead", res_id: 42, body: "one", message_id: 1 },
      { model: "crm.lead", res_id: 42, body: "two", message_id: 2 },
    ];
    await adapter(items);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].batchKey, "multi");
    assert.equal(calls[0].messages.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
