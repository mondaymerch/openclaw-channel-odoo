/**
 * Tests for src/inbox/scheduler.ts.
 *
 * Run: npx tsx --test tests/scheduler.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInboxQueue, type BatchRef } from "../src/inbox/queue.js";
import { createRecordLock } from "../src/inbox/record-lock.js";
import {
  createRetryScheduler,
  type ProcessBatchFn,
} from "../src/inbox/scheduler.js";
import {
  ensureInboxQueueDirs,
  mutateBatch,
  readBatch,
  resolveInboxQueuePaths,
} from "../src/inbox/store.js";
import type { InboxBatch } from "../src/inbox/types.js";

// ---- Fake timers ----

type Pending = { id: number; fn: () => void; delayMs: number };

function makeFakeTimers() {
  const pending: Pending[] = [];
  let nextId = 1;
  const setTimer = (fn: () => void, delayMs: number) => {
    const id = nextId++;
    pending.push({ id, fn, delayMs });
    return id;
  };
  const clearTimer = (handle: unknown) => {
    const idx = pending.findIndex((p) => p.id === handle);
    if (idx >= 0) pending.splice(idx, 1);
  };
  // Fire all currently-pending timers in scheduling order, then wait long
  // enough for fire()'s async chain (real file I/O) to settle. Using a
  // small setTimeout is more reliable than counting microtask drains —
  // readBatch involves readdir + readFile + parse, multiple I/O awaits.
  async function flushAll() {
    const snapshot = pending.splice(0);
    for (const { fn } of snapshot) fn();
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  return { setTimer, clearTimer, flushAll, pending };
}

// ---- Logger spy ----

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

// ---- Harness ----

async function makeSchedulerHarness(opts: {
  keys?: string[];
  processBatch?: ProcessBatchFn;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "odoo-inbox-sched-"));
  const paths = resolveInboxQueuePaths(dir);
  await ensureInboxQueueDirs(paths);

  const keys = opts.keys ?? [];
  let keyIdx = 0;
  const newBatchKey = () =>
    keyIdx < keys.length ? keys[keyIdx++] : `auto-${keyIdx++}`;

  const lock = createRecordLock();
  const queue = createInboxQueue({ paths, lock, newBatchKey });

  const processed: InboxBatch[] = [];
  const processBatch = opts.processBatch
    ?? (async (b: InboxBatch) => { processed.push(b); });

  const timers = makeFakeTimers();
  const logger = makeLogger();

  const scheduler = createRetryScheduler({
    paths,
    queue,
    processBatch,
    logger: logger.logger,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  return { dir, paths, queue, scheduler, timers, logger, processed };
}

function enqueueInput(message_id: number, body = "msg") {
  return {
    model: "crm.lead",
    res_id: 106665,
    message_id,
    body,
    user_name: "Tester",
    partner_id: 1,
  };
}

const refOf = (batchKey: string): BatchRef => ({
  model: "crm.lead",
  res_id: 106665,
  batchKey,
});

// ============================================================
// handleFailure — backoff + cap (9 tests)
// ============================================================

test("H1: silent 1st failure → schedules retry with DISPATCH_BACKOFF_MS[0] = 30_000", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await scheduler.handleFailure(refOf("abc"), "silent", new Error("e"));

    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delayMs, 30_000);
    const batch = await readBatch(paths, "abc");
    assert.equal(batch?.dispatchAttempts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H2: silent 2nd failure → schedules retry with DISPATCH_BACKOFF_MS[1] = 120_000", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    // Pre-bump dispatchAttempts to 1 via the facade directly (skips scheduling).
    await queue.recordFailure(refOf("abc"), "silent", new Error("pre"));
    timers.pending.splice(0);  // discard any pending (none from facade, but be safe)

    await scheduler.handleFailure(refOf("abc"), "silent", new Error("e"));

    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delayMs, 120_000);
    const batch = await readBatch(paths, "abc");
    assert.equal(batch?.dispatchAttempts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H3: silent 3rd failure → abandon (move to failed/, no timer)", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await queue.recordFailure(refOf("abc"), "silent", new Error("1"));
    await queue.recordFailure(refOf("abc"), "silent", new Error("2"));
    // dispatchAttempts = 2 now

    await scheduler.handleFailure(refOf("abc"), "silent", new Error("3"));

    assert.equal(timers.pending.length, 0);
    assert.equal(await readBatch(paths, "abc"), null);
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, ["crm.lead__106665__abc.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H4: internal_error shares dispatchAttempts with silent", async () => {
  const { dir, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await queue.recordFailure(refOf("abc"), "silent", new Error("pre"));
    timers.pending.splice(0);

    await scheduler.handleFailure(refOf("abc"), "internal_error", new Error("e"));

    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delayMs, 120_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H5: xmlrpc_failure progression 1..5 → backoff[0..3] then abandon", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    const expected = [5_000, 25_000, 120_000, 600_000];

    for (let i = 0; i < 4; i += 1) {
      timers.pending.splice(0);
      await scheduler.handleFailure(refOf("abc"), "xmlrpc_failure", new Error(`attempt ${i + 1}`));
      assert.equal(timers.pending.length, 1, `attempt ${i + 1} should schedule`);
      assert.equal(timers.pending[0].delayMs, expected[i], `attempt ${i + 1} delay`);
    }

    // 5th failure → abandon
    timers.pending.splice(0);
    await scheduler.handleFailure(refOf("abc"), "xmlrpc_failure", new Error("attempt 5"));

    assert.equal(timers.pending.length, 0);
    assert.equal(await readBatch(paths, "abc"), null);
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, ["crm.lead__106665__abc.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H6: mixed silent + xmlrpc track independent counters", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));

    await scheduler.handleFailure(refOf("abc"), "silent", new Error("s1"));
    await scheduler.handleFailure(refOf("abc"), "xmlrpc_failure", new Error("x1"));
    await scheduler.handleFailure(refOf("abc"), "xmlrpc_failure", new Error("x2"));
    await scheduler.handleFailure(refOf("abc"), "silent", new Error("s2"));

    const final = await readBatch(paths, "abc");
    assert.equal(final?.dispatchAttempts, 2);
    assert.equal(final?.deliveryAttempts, 2);
    // NOT abandoned — neither counter at cap (3 / 5).
    assert.equal(final?.state, "received");

    // The most recent schedule was from the silent → use DISPATCH_BACKOFF_MS[1] = 120_000
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delayMs, 120_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H7: handleFailure on missing file is a no-op", async () => {
  const { dir, paths, scheduler, timers } = await makeSchedulerHarness();
  try {
    await scheduler.handleFailure(refOf("ghost"), "silent", new Error("e"));
    assert.equal(timers.pending.length, 0);
    const queueFiles = (await readdir(paths.queueDir)).filter((n) => n !== "failed");
    assert.deepEqual(queueFiles, []);
    assert.deepEqual(await readdir(paths.failedDir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H8: handleFailure with abandon cancels any prior timer", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await queue.recordFailure(refOf("abc"), "silent", new Error("1"));
    await queue.recordFailure(refOf("abc"), "silent", new Error("2"));
    // dispatchAttempts = 2 — one more will cap.

    // Plant a manual timer for this batchKey.
    const batch = await readBatch(paths, "abc");
    assert.ok(batch);
    scheduler.scheduleAt(batch, 10_000);
    assert.equal(timers.pending.length, 1);

    // Now trigger abandon.
    await scheduler.handleFailure(refOf("abc"), "silent", new Error("3"));

    // Pending should be empty — the planted timer was canceled before abandon.
    assert.equal(timers.pending.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H9: handleFailure logs an abandon line on cap exhaustion", async () => {
  const { dir, queue, scheduler, logger } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await queue.recordFailure(refOf("abc"), "silent", new Error("1"));
    await queue.recordFailure(refOf("abc"), "silent", new Error("2"));

    await scheduler.handleFailure(refOf("abc"), "silent", new Error("3"));

    const abandonLines = logger.errors.filter((m) => m.includes("inbox.abandoned"));
    assert.equal(abandonLines.length, 1);
    assert.ok(abandonLines[0].includes("batchKey=abc"));
    assert.ok(abandonLines[0].includes("class=silent"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// scheduleAt (3 tests)
// ============================================================

test("S1: scheduleAt fires processBatch with the FRESH batch (not the snapshot)", async () => {
  const { dir, paths, queue, scheduler, timers, processed } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    const snapshot = await readBatch(paths, "abc");
    assert.ok(snapshot);

    // Mutate the file externally — add a second message.
    await mutateBatch(paths, "abc", (b) => {
      b.messages.push({
        message_id: 101,
        body: "added later",
        receivedAt: 9999,
      });
    });

    scheduler.scheduleAt(snapshot, 100);
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delayMs, 100);

    await timers.flushAll();

    assert.equal(processed.length, 1);
    // Fresh state from disk, not the stale snapshot:
    assert.equal(processed[0].messages.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S2: scheduleAt with delay 0 still goes through the timer (fires on flush)", async () => {
  const { dir, paths, queue, scheduler, timers, processed } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    const batch = await readBatch(paths, "abc");
    assert.ok(batch);

    scheduler.scheduleAt(batch, 0);
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delayMs, 0);

    await timers.flushAll();
    assert.equal(processed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3: scheduleAt for the same batchKey twice cancels the first timer", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    const batch = await readBatch(paths, "abc");
    assert.ok(batch);

    scheduler.scheduleAt(batch, 1000);
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delayMs, 1000);

    scheduler.scheduleAt(batch, 500);
    assert.equal(timers.pending.length, 1, "old timer cancelled, only one remains");
    assert.equal(timers.pending[0].delayMs, 500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// fire — race safety (3 tests)
// ============================================================

test("F1: fire on a file that was unlinked between schedule and fire is a no-op", async () => {
  const { dir, queue, scheduler, timers, processed } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await scheduler.handleFailure(refOf("abc"), "silent", new Error("e"));
    assert.equal(timers.pending.length, 1);

    // Simulate concurrent unlink (e.g., a stale closure finished delivering).
    await queue.recordDeliverySuccess(refOf("abc"));

    await timers.flushAll();
    assert.equal(processed.length, 0, "processBatch should NOT be called");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F2: fire reads fresh state, not the at-schedule snapshot (alt path via handleFailure)", async () => {
  const { dir, paths, queue, scheduler, timers, processed } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await scheduler.handleFailure(refOf("abc"), "silent", new Error("e"));

    // Mutate the file between schedule and fire.
    await mutateBatch(paths, "abc", (b) => {
      b.lastError = "mutated externally";
    });

    await timers.flushAll();
    assert.equal(processed.length, 1);
    assert.equal(processed[0].lastError, "mutated externally");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F3: processBatch throwing is logged; scheduler keeps working", async () => {
  let throwIt = true;
  const { dir, paths, queue, scheduler, timers, logger } =
    await makeSchedulerHarness({
      keys: ["abc", "def"],
      processBatch: async () => {
        if (throwIt) throw new Error("oops");
      },
    });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await scheduler.handleFailure(refOf("abc"), "silent", new Error("e"));
    await timers.flushAll();

    const errs = logger.errors.filter((m) => m.includes("processBatch threw"));
    assert.equal(errs.length, 1);
    assert.ok(errs[0].includes("batchKey=abc"));

    // Subsequent scheduling still works.
    throwIt = false;
    await queue.appendOrCreateBatch({
      model: "crm.lead", res_id: 99, message_id: 200, body: "ok",
    });
    const batch = await readBatch(paths, "def");
    assert.ok(batch);
    scheduler.scheduleAt(batch, 50);
    assert.equal(timers.pending.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// cancelAll (2 tests)
// ============================================================

test("C1: cancelAll clears all pending timers; flushAll fires nothing", async () => {
  const { dir, queue, scheduler, timers, processed } =
    await makeSchedulerHarness({ keys: ["a", "b"] });
  try {
    await queue.appendOrCreateBatch({ model: "crm.lead", res_id: 1, message_id: 100, body: "a" });
    await queue.appendOrCreateBatch({ model: "crm.lead", res_id: 2, message_id: 200, body: "b" });

    await scheduler.handleFailure({ model: "crm.lead", res_id: 1, batchKey: "a" }, "silent", new Error("e"));
    await scheduler.handleFailure({ model: "crm.lead", res_id: 2, batchKey: "b" }, "silent", new Error("e"));
    assert.equal(timers.pending.length, 2);

    scheduler.cancelAll();
    assert.equal(timers.pending.length, 0);

    await timers.flushAll();
    assert.equal(processed.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C2: scheduler usable after cancelAll", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["a"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await scheduler.handleFailure(
      { model: "crm.lead", res_id: 106665, batchKey: "a" },
      "silent",
      new Error("e"),
    );
    scheduler.cancelAll();

    const batch = await readBatch(paths, "a");
    assert.ok(batch);
    scheduler.scheduleAt(batch, 50);
    assert.equal(timers.pending.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Integration smoke (3 tests)
// ============================================================

test("I1: handleFailure → flushAll → processBatch called with current state", async () => {
  const { dir, queue, scheduler, timers, processed } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));
    await scheduler.handleFailure(refOf("abc"), "silent", new Error("e"));
    await timers.flushAll();

    assert.equal(processed.length, 1);
    assert.equal(processed[0].batchKey, "abc");
    assert.equal(processed[0].dispatchAttempts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I2: silent cascade — 3 handleFailure calls in a row → abandoned", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));

    for (let i = 0; i < 3; i += 1) {
      await scheduler.handleFailure(refOf("abc"), "silent", new Error(`${i + 1}`));
      timers.pending.splice(0);   // discard scheduled retries; we drive the cascade manually
    }

    assert.equal(await readBatch(paths, "abc"), null);
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, ["crm.lead__106665__abc.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I3: xmlrpc_failure cascade — 5 handleFailure calls yield abandon at #5", async () => {
  const { dir, paths, queue, scheduler, timers } =
    await makeSchedulerHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(enqueueInput(100));

    for (let i = 0; i < 5; i += 1) {
      await scheduler.handleFailure(refOf("abc"), "xmlrpc_failure", new Error(`${i + 1}`));
      timers.pending.splice(0);
    }

    assert.equal(await readBatch(paths, "abc"), null);
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, ["crm.lead__106665__abc.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
