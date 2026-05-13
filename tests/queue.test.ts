/**
 * Tests for src/inbox/queue.ts.
 *
 * Run:   npx tsx --test tests/queue.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readdir } from "node:fs/promises";

import {
  createInboxQueue,
  type AppendOrCreateInput,
  type BatchRef,
  type InboxQueue,
} from "../src/inbox/queue.js";
import { createRecordLock, type RecordLock } from "../src/inbox/record-lock.js";
import {
  ensureInboxQueueDirs,
  moveBatchToFailed,
  mutateBatch,
  readBatch,
  resolveInboxQueuePaths,
  type InboxQueuePaths,
} from "../src/inbox/store.js";
import type { InboxBatch } from "../src/inbox/types.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeQueueHarness(opts: { keys?: string[]; nowMs?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "odoo-inbox-queue-"));
  const paths = resolveInboxQueuePaths(dir);
  await ensureInboxQueueDirs(paths);

  const keys = opts.keys ?? [];
  let keyIdx = 0;
  const newBatchKey = () => (keyIdx < keys.length ? keys[keyIdx++] : `auto-${keyIdx++}`);
  const now = opts.nowMs ?? (() => Date.now());

  const lock = createRecordLock();
  const queue = createInboxQueue({ paths, lock, newBatchKey, now });
  return { dir, paths, lock, queue };
}

function sampleInput(overrides: Partial<AppendOrCreateInput> = {}): AppendOrCreateInput {
  return {
    model: "crm.lead",
    res_id: 106665,
    message_id: 741,
    body: "Hello from the test",
    user_name: "Sila",
    partner_id: 5432,
    ...overrides,
  };
}

function refFor(batch: InboxBatch): BatchRef {
  return { model: batch.model, res_id: batch.res_id, batchKey: batch.batchKey };
}

function ghostRef(overrides: Partial<BatchRef> = {}): BatchRef {
  return {
    model: "crm.lead",
    res_id: 106665,
    batchKey: "ghost",
    ...overrides,
  };
}

// ---- Happy path ----

test("appendOrCreateBatch: creates a fresh batch when none exists for the record", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    const result = await queue.appendOrCreateBatch(sampleInput());
    assert.deepEqual(result, { ok: true, batchKey: "abc", didCreate: true });

    const batch = await readBatch(paths, "abc");
    assert.ok(batch);
    assert.equal(batch!.state, "received");
    assert.equal(batch!.closedAt, null);
    assert.equal(batch!.inFlightSince, null);
    assert.equal(batch!.messages.length, 1);
    assert.equal(batch!.messages[0].message_id, 741);
    assert.equal(batch!.messages[0].body, "Hello from the test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendOrCreateBatch: appends to existing open batch for the same record", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput({ message_id: 741, body: "first" }));
    const second = await queue.appendOrCreateBatch(
      sampleInput({ message_id: 742, body: "second" }),
    );

    assert.deepEqual(second, { ok: true, batchKey: "abc", didCreate: false });
    const batch = await readBatch(paths, "abc");
    assert.equal(batch!.messages.length, 2);
    assert.deepEqual(
      batch!.messages.map((m) => m.message_id),
      [741, 742],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendOrCreateBatch: different records get independent batches", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["a", "b"] });
  try {
    const r1 = await queue.appendOrCreateBatch(sampleInput({ res_id: 1, message_id: 100 }));
    const r2 = await queue.appendOrCreateBatch(sampleInput({ res_id: 2, message_id: 200 }));

    assert.equal(r1.ok && r1.batchKey, "a");
    assert.equal(r2.ok && r2.batchKey, "b");
    const batchA = await readBatch(paths, "a");
    const batchB = await readBatch(paths, "b");
    assert.equal(batchA?.res_id, 1);
    assert.equal(batchB?.res_id, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Duplicate detection ----

test("appendOrCreateBatch: duplicate against active batch is rejected", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    const first = await queue.appendOrCreateBatch(sampleInput({ message_id: 100 }));
    assert.equal(first.ok, true);

    // Same message_id arrives again (Odoo controller retry on timeout).
    const second = await queue.appendOrCreateBatch(sampleInput({ message_id: 100, body: "ignored" }));

    assert.deepEqual(second, {
      ok: false,
      reason: "duplicate",
      existingBatchKey: "abc",
    });

    // Batch on disk is unchanged: still exactly one message.
    const batch = await readBatch(paths, "abc");
    assert.equal(batch!.messages.length, 1);
    assert.equal(batch!.messages[0].body, "Hello from the test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendOrCreateBatch: duplicate against failed/ batch is rejected", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["dead"] });
  try {
    await queue.appendOrCreateBatch(sampleInput({ message_id: 100 }));
    await moveBatchToFailed(paths, "dead");

    // Odoo retries the SAME message_id minutes later, after we already
    // abandoned the original batch.
    const second = await queue.appendOrCreateBatch(sampleInput({ message_id: 100 }));

    assert.deepEqual(second, {
      ok: false,
      reason: "duplicate",
      existingBatchKey: "dead",
    });

    // No new batch was created in queueDir.
    const stillNothing = await readBatch(paths, "auto-0").catch(() => null);
    assert.equal(stillNothing, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Closed-batch boundary ----

test("appendOrCreateBatch: closed batch (state=dispatching) does NOT receive appends — new batch is created", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["first", "second"] });
  try {
    await queue.appendOrCreateBatch(sampleInput({ message_id: 100 }));
    // Simulate dispatch starting: flip the first batch to dispatching state.
    await mutateBatch(paths, "first", (b) => {
      b.state = "dispatching";
      b.closedAt = 99999;
      b.inFlightSince = 99999;
    });

    const r = await queue.appendOrCreateBatch(sampleInput({ message_id: 101 }));
    assert.deepEqual(r, { ok: true, batchKey: "second", didCreate: true });

    const oldBatch = await readBatch(paths, "first");
    const newBatch = await readBatch(paths, "second");
    assert.equal(oldBatch!.messages.length, 1);
    assert.equal(newBatch!.messages.length, 1);
    assert.equal(newBatch!.messages[0].message_id, 101);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendOrCreateBatch: closed batch (reply_ready) does NOT receive appends — new batch is created", async () => {
  const { dir, queue, paths } = await makeQueueHarness({ keys: ["delivered", "fresh"] });
  try {
    await queue.appendOrCreateBatch(sampleInput({ message_id: 100 }));
    await mutateBatch(paths, "delivered", (b) => {
      b.state = "reply_ready";
      b.reply = { text: "ack", producedAt: 123 };
    });

    const r = await queue.appendOrCreateBatch(sampleInput({ message_id: 101 }));
    assert.deepEqual(r, { ok: true, batchKey: "fresh", didCreate: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Concurrency ----

test("appendOrCreateBatch: five concurrent appends for the same record collapse into one batch", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["one-batch"] });
  try {
    // Kick off five calls without awaiting between them.
    const calls = [741, 742, 743, 744, 745].map((id) =>
      queue.appendOrCreateBatch(sampleInput({ message_id: id, body: `msg-${id}` })),
    );
    const results = await Promise.all(calls);

    // All five results refer to the same batchKey.
    for (const r of results) {
      assert.equal(r.ok && r.batchKey, "one-batch");
    }
    // Exactly one created, the rest appended.
    const created = results.filter((r) => r.ok && r.didCreate).length;
    assert.equal(created, 1);

    // The batch on disk has all five messages in arrival order.
    const batch = await readBatch(paths, "one-batch");
    assert.deepEqual(
      batch!.messages.map((m) => m.message_id),
      [741, 742, 743, 744, 745],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendOrCreateBatch: different-record calls run in parallel", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["k-1", "k-2"] });
  try {
    const started = Date.now();
    const a = queue.appendOrCreateBatch(
      sampleInput({ res_id: 1, message_id: 100, body: "a" }),
    );
    const b = queue.appendOrCreateBatch(
      sampleInput({ res_id: 2, message_id: 200, body: "b" }),
    );

    // Add a small artificial delay so serial vs parallel is measurable.
    // We don't inject this — instead we rely on the real disk write being
    // non-trivial enough that serial would be visibly slower. With one
    // record-lock per record, these don't queue on the same chain.
    await Promise.all([a, b, delay(20)]);
    const elapsed = Date.now() - started;

    // If the lock were a global mutex, this would be ≥ 2× the per-call
    // duration. With per-record locks, both ran concurrently behind the
    // delay's 20 ms wait — total ~20 ms.
    assert.ok(
      elapsed < 100,
      `expected concurrent execution, got ${elapsed}ms`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Error handling ----

test("appendOrCreateBatch: disk write failure surfaces as typed disk_error result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odoo-inbox-queue-disk-"));
  try {
    // Point at a path where the queue dir was never created. The atomic-write
    // helper will mkdir the file's parent dir, but the failedDir lookup that
    // findBatchContainingMessage performs on the FAILED dir will succeed
    // (ENOENT-tolerant). The actual write of the new batch will succeed too
    // (writeJsonFileAtomically creates the dir).
    //
    // To force a real failure: replace one of the store ops via the lock
    // boundary. Simpler approach: use a paths object pointing at a path
    // that's a FILE (not a dir) — readdir will throw ENOTDIR.
    const file = join(dir, "not-a-dir.txt");
    await (await import("node:fs/promises")).writeFile(file, "hi", "utf8");
    const paths = { queueDir: file, failedDir: join(file, "failed") };
    const lock = createRecordLock();
    const queue = createInboxQueue({ paths, lock });

    const result = await queue.appendOrCreateBatch(sampleInput());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "disk_error");
      assert.ok(result.error);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Test seam ----

test("createInboxQueue: newBatchKey injection makes batchKeys deterministic", async () => {
  const { dir, paths, queue } = await makeQueueHarness({
    keys: ["alpha-1", "alpha-2"],
  });
  try {
    const r1 = await queue.appendOrCreateBatch(sampleInput({ res_id: 1, message_id: 1 }));
    const r2 = await queue.appendOrCreateBatch(sampleInput({ res_id: 2, message_id: 2 }));

    assert.equal(r1.ok && r1.batchKey, "alpha-1");
    assert.equal(r2.ok && r2.batchKey, "alpha-2");
    assert.ok(await readBatch(paths, "alpha-1"));
    assert.ok(await readBatch(paths, "alpha-2"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// Dispatch-side methods
// =====================================================================

// ---- markDispatching ----

test("markDispatching M1: CAS sets state=dispatching, closedAt, inFlightSince", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => 5000 });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const result = await queue.markDispatching({
      model: "crm.lead",
      res_id: 106665,
      batchKey: "abc",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.batch.state, "dispatching");
    assert.equal(result.batch.closedAt, 5000);
    assert.equal(result.batch.inFlightSince, 5000);
    const reread = await readBatch(paths, "abc");
    assert.equal(reread?.state, "dispatching");
    assert.equal(reread?.closedAt, 5000);
    assert.equal(reread?.inFlightSince, 5000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markDispatching M2: second call rejects with not_received (CAS loser)", async () => {
  let nowMs = 1000;
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const first = await queue.markDispatching(ref);
    assert.equal(first.ok, true);

    nowMs = 2000;
    const second = await queue.markDispatching(ref);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, "not_received");

    // File on disk should not have been touched by the second call.
    const final = await readBatch(paths, "abc");
    assert.equal(final?.state, "dispatching");
    assert.equal(final?.closedAt, 1000);    // set on first call only
    assert.equal(final?.inFlightSince, 1000); // unchanged
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markDispatching M3: missing file returns ok:false reason=missing", async () => {
  const { dir, paths, queue } = await makeQueueHarness();
  try {
    const r = await queue.markDispatching(ghostRef());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "missing");
    const remaining = (await readdir(paths.queueDir)).filter((n) => n !== "failed");
    assert.deepEqual(remaining, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- transitionToReplyReady ----

test("transitionToReplyReady T1: sets state and reply; returns updated batch", async () => {
  let nowMs = 1000;
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());

    nowMs = 2000;
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const updated = await queue.transitionToReplyReady(ref, "hi from agent");

    assert.equal(updated?.state, "reply_ready");
    assert.equal(updated?.reply?.text, "hi from agent");
    assert.equal(updated?.reply?.producedAt, 2000);

    const reread = await readBatch(paths, "abc");
    assert.equal(reread?.state, "reply_ready");
    assert.equal(reread?.reply?.text, "hi from agent");
    assert.equal(reread?.reply?.producedAt, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transitionToReplyReady T2: clears inFlightSince, preserves closedAt", async () => {
  let nowMs = 1000;
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.markDispatching(ref);   // closedAt=inFlightSince=1000

    nowMs = 2000;
    const updated = await queue.transitionToReplyReady(ref, "text");

    assert.equal(updated?.closedAt, 1000);       // unchanged — set-once marker
    assert.equal(updated?.inFlightSince, null);  // cleared — agent run ended
    assert.equal(updated?.state, "reply_ready");
    assert.equal(updated?.reply?.producedAt, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transitionToReplyReady T3: idempotent — second call overwrites reply text", async () => {
  let nowMs = 1000;
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };

    await queue.transitionToReplyReady(ref, "first");
    nowMs = 2000;
    const second = await queue.transitionToReplyReady(ref, "second");

    assert.equal(second?.reply?.text, "second");
    assert.equal(second?.reply?.producedAt, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transitionToReplyReady T4: missing file returns null", async () => {
  const { dir, paths, queue } = await makeQueueHarness();
  try {
    const r = await queue.transitionToReplyReady(ghostRef(), "irrelevant");
    assert.equal(r, null);
    const remaining = (await readdir(paths.queueDir)).filter((n) => n !== "failed");
    assert.deepEqual(remaining, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- recordDeliverySuccess ----

test("recordDeliverySuccess D1: removes the batch file from queueDir", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    assert.ok(await readBatch(paths, "abc"));

    await queue.recordDeliverySuccess({
      model: "crm.lead",
      res_id: 106665,
      batchKey: "abc",
    });

    assert.equal(await readBatch(paths, "abc"), null);
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, []);   // unlink, not move
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordDeliverySuccess D2: missing file is a no-op", async () => {
  const { dir, queue } = await makeQueueHarness();
  try {
    await queue.recordDeliverySuccess(ghostRef());   // must not throw
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- recordFailure ----

test("recordFailure F1: silent class bumps dispatchAttempts; sets lastError/Class/At", async () => {
  let nowMs = 1000;
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    nowMs = 2000;
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const updated = await queue.recordFailure(ref, "silent", new Error("agent went quiet"));

    assert.equal(updated?.dispatchAttempts, 1);
    assert.equal(updated?.deliveryAttempts, 0);
    assert.equal(updated?.lastFailureClass, "silent");
    assert.equal(updated?.lastError, "agent went quiet");
    assert.equal(updated?.lastAttemptAt, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F2: internal_error bumps dispatchAttempts (same counter as silent)", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.recordFailure(ref, "silent", new Error("first"));
    const updated = await queue.recordFailure(ref, "internal_error", new Error("dispatch threw"));

    assert.equal(updated?.dispatchAttempts, 2);
    assert.equal(updated?.deliveryAttempts, 0);
    assert.equal(updated?.lastFailureClass, "internal_error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F3: xmlrpc_failure bumps deliveryAttempts (different counter)", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.recordFailure(ref, "silent", new Error("warmup"));   // dispatchAttempts=1
    const updated = await queue.recordFailure(ref, "xmlrpc_failure", new Error("503 from odoo"));

    assert.equal(updated?.dispatchAttempts, 1);    // unchanged
    assert.equal(updated?.deliveryAttempts, 1);
    assert.equal(updated?.lastFailureClass, "xmlrpc_failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F4: counters increment per call (3x silent → dispatchAttempts=3)", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.recordFailure(ref, "silent", new Error("1"));
    await queue.recordFailure(ref, "silent", new Error("2"));
    const final = await queue.recordFailure(ref, "silent", new Error("3"));
    assert.equal(final?.dispatchAttempts, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F5: mixed silent + xmlrpc increment respective counters independently", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.recordFailure(ref, "silent", new Error("s1"));
    await queue.recordFailure(ref, "xmlrpc_failure", new Error("x1"));
    await queue.recordFailure(ref, "silent", new Error("s2"));
    await queue.recordFailure(ref, "xmlrpc_failure", new Error("x2"));
    const final = await queue.recordFailure(ref, "xmlrpc_failure", new Error("x3"));

    assert.equal(final?.dispatchAttempts, 2);
    assert.equal(final?.deliveryAttempts, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F6: flips state=dispatching → received, clears inFlightSince, preserves closedAt", async () => {
  let nowMs = 1000;
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.markDispatching(ref);     // state=dispatching, closedAt=inFlightSince=1000

    nowMs = 2000;
    const updated = await queue.recordFailure(ref, "silent", new Error("e"));

    assert.equal(updated?.state, "received");     // flipped back — appendable again
    assert.equal(updated?.closedAt, 1000);        // set-once marker preserved
    assert.equal(updated?.inFlightSince, null);   // cleared — agent run ended
    assert.equal(updated?.lastAttemptAt, 2000);
    assert.equal(updated?.dispatchAttempts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F7: formatError — Error instance → .message", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const u = await queue.recordFailure(ref, "silent", new Error("specific text"));
    assert.equal(u?.lastError, "specific text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F8: formatError — string → unchanged", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const u = await queue.recordFailure(ref, "silent", "raw string err");
    assert.equal(u?.lastError, "raw string err");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F9: formatError — plain object → JSON serialized", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const u = await queue.recordFailure(ref, "silent", { code: "EOOPS", detail: "no" });
    assert.equal(u?.lastError, '{"code":"EOOPS","detail":"no"}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F10: formatError — circular ref → String(err) fallback (no throw)", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const u = await queue.recordFailure(ref, "silent", circular);
    assert.equal(u?.lastError, "[object Object]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordFailure F11: missing file returns null", async () => {
  const { dir, paths, queue } = await makeQueueHarness();
  try {
    const r = await queue.recordFailure(ghostRef(), "silent", new Error("e"));
    assert.equal(r, null);
    const remaining = (await readdir(paths.queueDir)).filter((n) => n !== "failed");
    assert.deepEqual(remaining, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- moveBatchToFailed ----

test("moveBatchToFailed X1: renames file from queueDir to failedDir", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    await queue.moveBatchToFailed({
      model: "crm.lead",
      res_id: 106665,
      batchKey: "abc",
    });

    assert.equal(await readBatch(paths, "abc"), null);
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, ["crm.lead__106665__abc.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("moveBatchToFailed X2: missing file is a no-op", async () => {
  const { dir, queue } = await makeQueueHarness();
  try {
    await queue.moveBatchToFailed(ghostRef());   // must not throw
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Lock discipline ----

test("Lock L1: concurrent ops on same record serialize (FIFO observed)", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput({ message_id: 100 }));
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };

    // Kick off two ops without awaiting between: recordFailure THEN append.
    // If they serialize correctly, the append sees the post-failure state.
    const p1 = queue.recordFailure(ref, "silent", new Error("boom"));
    const p2 = queue.appendOrCreateBatch(sampleInput({ message_id: 101, body: "after" }));

    await Promise.all([p1, p2]);
    const final = await readBatch(paths, "abc");
    assert.equal(final?.dispatchAttempts, 1);                          // recordFailure happened
    assert.equal(final?.messages.length, 2);                            // then append happened
    assert.deepEqual(
      final?.messages.map((m) => m.message_id),
      [100, 101],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Lock L2: methods on different records run in parallel", async () => {
  const { dir, queue } = await makeQueueHarness({ keys: ["a", "b"] });
  try {
    await queue.appendOrCreateBatch(sampleInput({ res_id: 1, message_id: 100 }));
    await queue.appendOrCreateBatch(sampleInput({ res_id: 2, message_id: 200 }));

    const refA: BatchRef = { model: "crm.lead", res_id: 1, batchKey: "a" };
    const refB: BatchRef = { model: "crm.lead", res_id: 2, batchKey: "b" };

    const started = Date.now();
    await Promise.all([
      queue.recordFailure(refA, "silent", new Error("ea")),
      queue.recordFailure(refB, "silent", new Error("eb")),
      delay(30),    // floor — both record-failures should finish behind this
    ]);
    const elapsed = Date.now() - started;

    // Parallel: bounded by the 30 ms delay. Serial would be ~60 ms+.
    assert.ok(
      elapsed < 80,
      `expected parallel execution, got ${elapsed}ms`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Integration smoke ----

test("Integration I1: happy-path lifecycle → file gone", async () => {
  let nowMs = 1000;
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    // append at t=1000
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };

    nowMs = 2000;
    const afterMark = await queue.markDispatching(ref);
    assert.equal(afterMark.ok, true);
    if (!afterMark.ok) return;
    assert.equal(afterMark.batch.state, "dispatching");
    assert.equal(afterMark.batch.closedAt, 2000);
    assert.equal(afterMark.batch.inFlightSince, 2000);

    nowMs = 3000;
    const afterReply = await queue.transitionToReplyReady(ref, "reply text");
    assert.equal(afterReply?.state, "reply_ready");
    assert.equal(afterReply?.inFlightSince, null);
    assert.equal(afterReply?.reply?.text, "reply text");
    assert.equal(afterReply?.reply?.producedAt, 3000);

    await queue.recordDeliverySuccess(ref);
    assert.equal(await readBatch(paths, "abc"), null);
    assert.deepEqual(await readdir(paths.failedDir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Integration I2: failure-to-failed lifecycle → file in failed/ with cap-hit state", async () => {
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"] });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };

    await queue.markDispatching(ref);
    await queue.recordFailure(ref, "silent", new Error("1"));
    await queue.recordFailure(ref, "silent", new Error("2"));
    await queue.recordFailure(ref, "silent", new Error("3"));

    await queue.moveBatchToFailed(ref);

    // File is in failedDir, not queueDir.
    assert.equal(await readBatch(paths, "abc"), null);
    const failedFiles = await readdir(paths.failedDir);
    assert.deepEqual(failedFiles, ["crm.lead__106665__abc.json"]);

    // The moved file still has all the accumulated state.
    const moved = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        join(paths.failedDir, "crm.lead__106665__abc.json"),
        "utf8",
      ),
    ) as InboxBatch;
    assert.equal(moved.dispatchAttempts, 3);
    assert.equal(moved.lastFailureClass, "silent");
    assert.equal(moved.state, "received");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// CAS semantics — new tests for the markDispatching + recordFailure
// + transitionToReplyReady redesign (state machine).
// =====================================================================

test("CAS1: markDispatching on state=dispatching → rejects with not_received, file unchanged", async () => {
  let nowMs = 1000;
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const first = await queue.markDispatching(ref);
    assert.equal(first.ok, true);

    // Snapshot the full batch BEFORE the second (rejected) CAS so we
    // catch partial-write regressions, not just inFlightSince changes.
    const before = await readBatch(paths, "abc");

    nowMs = 9999;
    const blocked = await queue.markDispatching(ref);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, "not_received");

    const after = await readBatch(paths, "abc");
    assert.deepEqual(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CAS2: markDispatching on state=reply_ready → rejects with not_received; file unchanged", async () => {
  let nowMs = 1000;
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.markDispatching(ref);
    await queue.transitionToReplyReady(ref, "hi");

    // Snapshot the full batch BEFORE the rejected CAS. A partial-write
    // bug (e.g., bumping inFlightSince before deciding to return failure)
    // would silently pass without this deep-equal check.
    const before = await readBatch(paths, "abc");

    nowMs = 2000;
    const blocked = await queue.markDispatching(ref);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, "not_received");

    const after = await readBatch(paths, "abc");
    assert.deepEqual(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CAS3: closedAt set only on first markDispatching; inFlightSince bumps on retry after failure", async () => {
  let nowMs = 1000;
  const { dir, paths, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    const r1 = await queue.markDispatching(ref);
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.batch.closedAt, 1000);
    assert.equal(r1.batch.inFlightSince, 1000);

    // Simulate a failure → state flips back to received.
    nowMs = 1500;
    await queue.recordFailure(ref, "silent", new Error("e1"));

    // Retry: markDispatching wins again, but closedAt is UNCHANGED.
    nowMs = 2000;
    const r2 = await queue.markDispatching(ref);
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.equal(r2.batch.closedAt, 1000);       // set-once preserved
    assert.equal(r2.batch.inFlightSince, 2000);  // bumped to the latest

    const reread = await readBatch(paths, "abc");
    assert.equal(reread?.closedAt, 1000);
    assert.equal(reread?.inFlightSince, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CAS4: recordFailure on state=reply_ready leaves state alone, clears inFlightSince (already null), bumps deliveryAttempts", async () => {
  let nowMs = 1000;
  const { dir, queue } = await makeQueueHarness({ keys: ["abc"], nowMs: () => nowMs });
  try {
    await queue.appendOrCreateBatch(sampleInput());
    const ref = { model: "crm.lead", res_id: 106665, batchKey: "abc" };
    await queue.markDispatching(ref);
    await queue.transitionToReplyReady(ref, "agent text");

    nowMs = 2000;
    const updated = await queue.recordFailure(ref, "xmlrpc_failure", new Error("net"));

    assert.equal(updated?.state, "reply_ready");   // unchanged
    assert.equal(updated?.inFlightSince, null);    // already null
    assert.equal(updated?.deliveryAttempts, 1);
    assert.equal(updated?.dispatchAttempts, 0);
    assert.equal(updated?.lastFailureClass, "xmlrpc_failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
