/**
 * Tests for src/inbox/recovery.ts.
 *
 * Run: npx tsx --test tests/recovery.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInboxQueue } from "../src/inbox/queue.js";
import { createRecordLock } from "../src/inbox/record-lock.js";
import { runBootRecovery } from "../src/inbox/recovery.js";
import { createRetryScheduler } from "../src/inbox/scheduler.js";
import {
  ensureInboxQueueDirs,
  resolveInboxQueuePaths,
  writeBatch,
  type InboxQueuePaths,
} from "../src/inbox/store.js";
import {
  AGENT_RUN_TIMEOUT_MS,
  REPLAY_STAGGER_MS,
  REPLAY_TTL_MS,
  type InboxBatch,
} from "../src/inbox/types.js";

// ---- Fake timers (same shape as scheduler.test.ts) ----

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
  return { setTimer, clearTimer, pending };
}

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

const T = 100_000_000_000;   // fixed "now" for all tests

async function makeRecoveryHarness(opts: { nowMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "odoo-inbox-recovery-"));
  const paths = resolveInboxQueuePaths(dir);
  await ensureInboxQueueDirs(paths);

  const lock = createRecordLock();
  const tNow = opts.nowMs ?? T;
  // Use the same fake clock for the queue so recordFailure inside the
  // stale-dispatching normalize path records lastAttemptAt at tNow.
  const queue = createInboxQueue({ paths, lock, now: () => tNow });
  const fakeTimers = makeFakeTimers();
  const logger = makeLogger();
  const scheduler = createRetryScheduler({
    paths,
    queue,
    processBatch: async () => {},   // recovery never invokes this directly
    logger: logger.logger,
    setTimer: fakeTimers.setTimer,
    clearTimer: fakeTimers.clearTimer,
  });

  return {
    dir, paths, queue, scheduler, fakeTimers, logger,
    deps: {
      paths, queue, scheduler,
      logger: logger.logger,
      now: () => tNow,
    },
    tNow,
  };
}

function makeBatch(overrides: Partial<InboxBatch> & { batchKey: string }): InboxBatch {
  return {
    batchKey: overrides.batchKey,
    state: "received",
    model: "crm.lead",
    res_id: 106665,
    messages: [{ message_id: 1, body: "hello", receivedAt: T }],
    enqueuedAt: T - 1000,
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

async function seedBatch(paths: InboxQueuePaths, batch: InboxBatch) {
  await writeBatch(paths, batch);
}

// ============================================================
// Empty / trivial (2 tests)
// ============================================================

test("R1: empty queue dir → all-zero summary", async () => {
  const { dir, fakeTimers, logger, deps } = await makeRecoveryHarness();
  try {
    const summary = await runBootRecovery(deps);

    assert.deepEqual(summary, {
      total: 0, eligibleReceived: 0, eligibleReplyReady: 0,
      notYetEligibleReceived: 0, deferred: 0, expired: 0, corrupt: 0,
    });
    assert.equal(fakeTimers.pending.length, 0);
    const bootLine = logger.infos.find((m) => m.includes("inbox.recovery total=0"));
    assert.ok(bootLine, "should have emitted boot summary log");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R2: queue dir doesn't exist → zeros, no throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odoo-inbox-recovery-missing-"));
  try {
    // Don't ensureInboxQueueDirs — paths point at a non-existent location.
    const paths = resolveInboxQueuePaths(join(dir, "definitely-not-a-dir"));
    const lock = createRecordLock();
    const queue = createInboxQueue({ paths, lock });
    const fakeTimers = makeFakeTimers();
    const logger = makeLogger();
    const scheduler = createRetryScheduler({
      paths, queue, processBatch: async () => {}, logger: logger.logger,
      setTimer: fakeTimers.setTimer, clearTimer: fakeTimers.clearTimer,
    });

    const summary = await runBootRecovery({
      paths, queue, scheduler, logger: logger.logger, now: () => T,
    });

    assert.equal(summary.total, 0);
    assert.equal(summary.corrupt, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Expire (2 tests)
// ============================================================

test("R3: received batch >1h old → moved to failed/, expired=1", async () => {
  const { dir, paths, fakeTimers, logger, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "old",
      state: "received",
      enqueuedAt: T - REPLAY_TTL_MS - 1,
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.expired, 1);
    assert.equal(summary.total, 1);
    assert.equal(fakeTimers.pending.length, 0);
    // File moved to failed/.
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, ["crm.lead__106665__old.json"]);
    const expiredLog = logger.errors.find((m) => m.includes("inbox.recovery expired"));
    assert.ok(expiredLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R4: reply_ready batch with old enqueuedAt → NOT expired, scheduled at delay 0", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "old-but-ready",
      state: "reply_ready",
      enqueuedAt: T - 2 * REPLAY_TTL_MS,
      reply: { text: "preserved", producedAt: T - 100 },
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.expired, 0);
    assert.equal(summary.eligibleReplyReady, 1);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, 0);
    // File still in queueDir.
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// reply_ready (1 test)
// ============================================================

test("R5: reply_ready overrides closedAt/backoff — always fires at delay 0", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "deliver-me",
      state: "reply_ready",
      closedAt: T - 100,                 // recent dispatch start
      inFlightSince: null,               // reply_ready always has this null
      deliveryAttempts: 2,
      lastAttemptAt: T - 50,             // backoff would say "wait"
      lastFailureClass: "xmlrpc_failure",
      reply: { text: "agent text", producedAt: T - 200 },
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.eligibleReplyReady, 1);
    assert.equal(summary.deferred, 0);
    assert.equal(summary.notYetEligibleReceived, 0);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Deferred (2 tests)
// ============================================================

test("R6: dispatching with fresh inFlightSince (3min) → deferred with delay = 12min", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    const threeMin = 3 * 60 * 1000;
    await seedBatch(paths, makeBatch({
      batchKey: "in-flight",
      state: "dispatching",
      closedAt: T - threeMin,
      inFlightSince: T - threeMin,
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.deferred, 1);
    assert.equal(fakeTimers.pending.length, 1);
    // delay = (T - 3min + 15min) - T = 12min
    assert.equal(fakeTimers.pending[0].delayMs, AGENT_RUN_TIMEOUT_MS - threeMin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R7: dispatching at staleness boundary → normalized to received, bumped dispatchAttempts, backoff-scheduled", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "boundary",
      state: "dispatching",
      closedAt: T - AGENT_RUN_TIMEOUT_MS,
      inFlightSince: T - AGENT_RUN_TIMEOUT_MS,   // exactly stale
    }));

    const summary = await runBootRecovery(deps);

    // Stale dispatching → recordFailure(internal_error) flips state back
    // to received with dispatchAttempts=1, lastAttemptAt=now(). Then
    // nextEligibleAt = lastAttemptAt + DISPATCH_BACKOFF_MS[0] = T + 30s.
    // So it lands in notYetEligibleReceived (not eligibleReceived).
    assert.equal(summary.deferred, 0);
    assert.equal(summary.notYetEligibleReceived, 1);
    assert.equal(fakeTimers.pending.length, 1);
    // delay ≈ DISPATCH_BACKOFF_MS[0] (the recordFailure timestamp ≈ now)
    assert.ok(Math.abs(fakeTimers.pending[0].delayMs - 30_000) < 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Backoff (3 tests)
// ============================================================

test("R8: received with active backoff → scheduled at exact remaining delay", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    // silent failure 1 → backoff = 30000ms; pretend 10s have elapsed
    await seedBatch(paths, makeBatch({
      batchKey: "waiting",
      state: "received",
      lastFailureClass: "silent",
      dispatchAttempts: 1,
      lastAttemptAt: T - 10_000,
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.notYetEligibleReceived, 1);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, 20_000);   // 30000 - 10000
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R9: received with backoff elapsed → eligible received (staggered)", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "ready",
      state: "received",
      lastFailureClass: "silent",
      dispatchAttempts: 1,
      lastAttemptAt: T - 60_000,    // 60s ago, well past 30s backoff
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.eligibleReceived, 1);
    assert.equal(summary.notYetEligibleReceived, 0);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R10: received with no prior attempt → eligible immediately", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "fresh",
      state: "received",
      lastAttemptAt: null,
      lastFailureClass: null,
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.eligibleReceived, 1);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Stagger (1 test)
// ============================================================

test("R11: 5 eligible-received batches → staggered at [0, 200, 400, 600, 800]ms", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    for (let i = 1; i <= 5; i += 1) {
      await seedBatch(paths, makeBatch({
        batchKey: `b${i}`,
        res_id: i,    // different recordKeys so they're distinct batches
        state: "received",
      }));
    }

    const summary = await runBootRecovery(deps);

    assert.equal(summary.eligibleReceived, 5);
    assert.equal(fakeTimers.pending.length, 5);
    const delays = fakeTimers.pending.map((p) => p.delayMs);
    assert.deepEqual(delays, [0, 200, 400, 600, 800].map((d) => d * (REPLAY_STAGGER_MS / 200)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Mixed (1 test)
// ============================================================

test("R12: mixed bucket — one of each kind partitioned correctly", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    // 1 expired
    await seedBatch(paths, makeBatch({
      batchKey: "expired",
      state: "received",
      enqueuedAt: T - REPLAY_TTL_MS - 1,
      res_id: 1,
    }));
    // 1 deferred
    await seedBatch(paths, makeBatch({
      batchKey: "deferred",
      state: "dispatching",
      closedAt: T - 60_000,
      inFlightSince: T - 60_000,       // 1 min ago — fresh
      res_id: 2,
    }));
    // 1 not-yet-eligible
    await seedBatch(paths, makeBatch({
      batchKey: "notyet",
      state: "received",
      lastFailureClass: "silent",
      dispatchAttempts: 1,
      lastAttemptAt: T - 5_000,        // 5s ago of 30s backoff
      res_id: 3,
    }));
    // 1 eligible received
    await seedBatch(paths, makeBatch({
      batchKey: "eligible",
      state: "received",
      res_id: 4,
    }));
    // 1 reply_ready
    await seedBatch(paths, makeBatch({
      batchKey: "ready",
      state: "reply_ready",
      reply: { text: "agent", producedAt: T - 1000 },
      res_id: 5,
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.total, 5);
    assert.equal(summary.expired, 1);
    assert.equal(summary.deferred, 1);
    assert.equal(summary.notYetEligibleReceived, 1);
    assert.equal(summary.eligibleReceived, 1);
    assert.equal(summary.eligibleReplyReady, 1);
    assert.equal(summary.corrupt, 0);

    // The expired one is in failed/; the other four have pending timers.
    const failed = await readdir(paths.failedDir);
    assert.equal(failed.length, 1);
    assert.ok(failed[0].includes("expired"));
    assert.equal(fakeTimers.pending.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Corrupt + logging (2 tests)
// ============================================================

test("R13: corrupt file → onCorrupt fires, scan continues, summary.corrupt incremented", async () => {
  const { dir, paths, fakeTimers, logger, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({ batchKey: "good", state: "received" }));
    // Plant a malformed JSON file with the correct naming pattern.
    await writeFile(
      join(paths.queueDir, "crm.lead__106665__bad.json"),
      "{not json",
      "utf8",
    );

    const summary = await runBootRecovery(deps);

    assert.equal(summary.corrupt, 1);
    assert.equal(summary.eligibleReceived, 1);   // the good one
    assert.equal(fakeTimers.pending.length, 1);
    const corruptLog = logger.errors.find((m) => m.includes("inbox.recovery corrupt"));
    assert.ok(corruptLog);
    assert.ok(corruptLog!.includes("bad.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R14: boot summary log line emitted with all counts", async () => {
  const { dir, paths, logger, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "exp",
      state: "received",
      enqueuedAt: T - REPLAY_TTL_MS - 1,
      res_id: 1,
    }));
    await seedBatch(paths, makeBatch({
      batchKey: "e1",
      state: "received",
      res_id: 2,
    }));
    await seedBatch(paths, makeBatch({
      batchKey: "e2",
      state: "received",
      res_id: 3,
    }));

    await runBootRecovery(deps);

    const bootLog = logger.infos.find((m) => m.includes("inbox.recovery total=3"));
    assert.ok(bootLog, "boot summary should be logged");
    assert.ok(bootLog!.includes("eligibleReceived=2"));
    assert.ok(bootLog!.includes("expired=1"));
    assert.ok(bootLog!.includes("replyReady=0"));
    assert.ok(bootLog!.includes("corrupt=0"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// NEW: state="dispatching" partition behavior
// ============================================================

test("R15: fresh dispatching batch (3min) → deferred 12min, file untouched on disk", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    const threeMin = 3 * 60 * 1000;
    await seedBatch(paths, makeBatch({
      batchKey: "in-flight",
      state: "dispatching",
      closedAt: T - threeMin,
      inFlightSince: T - threeMin,
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.deferred, 1);
    assert.equal(summary.eligibleReceived, 0);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, AGENT_RUN_TIMEOUT_MS - threeMin);

    // File must NOT have been mutated (no recordFailure on fresh defer).
    const { readBatch: readB } = await import("../src/inbox/store.js");
    const file = await readB(paths, "in-flight");
    assert.equal(file?.state, "dispatching");
    assert.equal(file?.inFlightSince, T - threeMin);
    assert.equal(file?.dispatchAttempts, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R16: stale dispatching batch → normalized to received with bumped dispatchAttempts + lastFailureClass=internal_error", async () => {
  const { dir, paths, fakeTimers, deps, logger } = await makeRecoveryHarness();
  try {
    const thirtyMin = 30 * 60 * 1000;
    await seedBatch(paths, makeBatch({
      batchKey: "crashed",
      state: "dispatching",
      closedAt: T - thirtyMin,
      inFlightSince: T - thirtyMin,    // 30min old — past the 15min staleness boundary
    }));

    await runBootRecovery(deps);

    const { readBatch: readB } = await import("../src/inbox/store.js");
    const file = await readB(paths, "crashed");
    assert.equal(file?.state, "received");                  // flipped back
    assert.equal(file?.dispatchAttempts, 1);                // bumped
    assert.equal(file?.lastFailureClass, "internal_error");
    assert.equal(file?.inFlightSince, null);                // cleared
    assert.ok(file?.lastError?.includes("stale dispatching"));

    // After normalization, the batch enters the notYetEligibleReceived
    // bucket (waiting for the DISPATCH_BACKOFF_MS[0]=30s backoff).
    assert.equal(fakeTimers.pending.length, 1);

    // Log the normalization event.
    const normLog = logger.infos.find((m) => m.includes("normalized stale dispatching"));
    assert.ok(normLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R17: stale dispatching aged past TTL → expired (moved to failed/)", async () => {
  const { dir, paths, deps } = await makeRecoveryHarness();
  try {
    await seedBatch(paths, makeBatch({
      batchKey: "old",
      state: "dispatching",
      enqueuedAt: T - REPLAY_TTL_MS - 1,   // older than 1h
      closedAt: T - REPLAY_TTL_MS,
      inFlightSince: T - REPLAY_TTL_MS,
    }));

    const summary = await runBootRecovery(deps);

    assert.equal(summary.expired, 1);
    assert.equal(summary.deferred, 0);
    const failedFiles = await readdir(paths.failedDir);
    assert.equal(failedFiles.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// R18: legacy on-disk shape → boot recovery → correct partition
// (end-to-end migration through the recovery flow)
// ============================================================

test("R18: legacy file (dispatchedAt + no failure) → normalized to dispatching → deferred bucket", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    const threeMin = 3 * 60 * 1000;
    // Write a LEGACY-shape JSON directly to disk (mimics a rolling deploy
    // where the previous gateway wrote with dispatchedAt and crashed
    // mid-dispatch). No closedAt / inFlightSince present.
    await writeFile(
      join(paths.queueDir, "crm.lead__106665__legacy.json"),
      JSON.stringify({
        batchKey: "legacy",
        state: "received",
        model: "crm.lead",
        res_id: 106665,
        messages: [{ message_id: 1, body: "hi", receivedAt: T - threeMin }],
        enqueuedAt: T - threeMin,
        dispatchedAt: T - threeMin,
        dispatchAttempts: 0,
        deliveryAttempts: 0,
        lastAttemptAt: null,             // no failure → was in flight at crash
        lastError: null,
        lastFailureClass: null,
        reply: null,
      }),
      "utf8",
    );

    const summary = await runBootRecovery(deps);

    // Normalizer reshapes the legacy field on read; recovery should then
    // route it via the fresh-dispatching defer bucket.
    assert.equal(summary.deferred, 1);
    assert.equal(summary.eligibleReceived, 0);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, AGENT_RUN_TIMEOUT_MS - threeMin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R19: legacy file (dispatchedAt + recorded failure) → normalized to received-in-backoff → backoff bucket", async () => {
  const { dir, paths, fakeTimers, deps } = await makeRecoveryHarness();
  try {
    await writeFile(
      join(paths.queueDir, "crm.lead__106665__legacy2.json"),
      JSON.stringify({
        batchKey: "legacy2",
        state: "received",
        model: "crm.lead",
        res_id: 106665,
        messages: [{ message_id: 1, body: "hi", receivedAt: T - 10_000 }],
        enqueuedAt: T - 10_000,
        dispatchedAt: T - 5_000,         // dispatch started 5s ago...
        dispatchAttempts: 1,
        deliveryAttempts: 0,
        lastAttemptAt: T - 4_000,        // ...and failed 4s ago
        lastError: "agent went silent",
        lastFailureClass: "silent",
        reply: null,
      }),
      "utf8",
    );

    const summary = await runBootRecovery(deps);

    // Normalizer reshapes to received-in-backoff. nextEligibleAt =
    // lastAttemptAt + DISPATCH_BACKOFF_MS[0] = T - 4_000 + 30_000 = T + 26_000.
    // Recovery routes to notYetEligibleReceived with delay = 26_000.
    assert.equal(summary.notYetEligibleReceived, 1);
    assert.equal(summary.deferred, 0);
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, 26_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
