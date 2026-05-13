/**
 * Tests for src/inbox/record-lock.ts.
 *
 * Run:   npx tsx --test tests/record-lock.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRecordLock } from "../src/inbox/record-lock.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("record-lock: single key serializes operations in arrival order", async () => {
  const lock = createRecordLock();
  const order: number[] = [];

  // Kick off three calls without awaiting between them so they queue up
  // simultaneously.
  const p1 = lock.withLock("k", async () => {
    await delay(30);
    order.push(1);
  });
  const p2 = lock.withLock("k", async () => {
    await delay(10);
    order.push(2);
  });
  const p3 = lock.withLock("k", async () => {
    await delay(5);
    order.push(3);
  });

  await Promise.all([p1, p2, p3]);

  // If serialization works, the array is strictly [1, 2, 3] even though p2
  // and p3 have shorter delays. If they interleaved, we'd see [3, 2, 1] or
  // some other ordering reflecting the delay magnitudes.
  assert.deepEqual(order, [1, 2, 3]);
});

test("record-lock: different keys run concurrently", async () => {
  const lock = createRecordLock();
  const started = Date.now();

  const a = lock.withLock("a", async () => {
    await delay(50);
  });
  const b = lock.withLock("b", async () => {
    await delay(50);
  });

  await Promise.all([a, b]);
  const elapsed = Date.now() - started;

  // Parallel: ~50ms. Serial would be ~100ms. Allow a generous upper bound
  // for CI scheduling jitter but well below the serial threshold.
  assert.ok(
    elapsed < 90,
    `expected parallel execution (~50ms), got ${elapsed}ms`,
  );
});

test("record-lock: a rejecting fn does not break the chain for subsequent callers", async () => {
  const lock = createRecordLock();
  const order: string[] = [];
  let caughtMessage: string | null = null;

  const failed = lock
    .withLock("k", async () => {
      order.push("first-attempt");
      throw new Error("boom");
    })
    .catch((err) => {
      caughtMessage = (err as Error).message;
    });

  const succeeded = lock.withLock("k", async () => {
    order.push("second-ran");
    return "ok";
  });

  await failed;
  const result = await succeeded;

  // The first call's rejection surfaced to its caller…
  assert.equal(caughtMessage, "boom");
  // …and the second call DID run despite the prior rejection (the chain
  // didn't deadlock). FIFO order is preserved between them.
  assert.equal(result, "ok");
  assert.deepEqual(order, ["first-attempt", "second-ran"]);
});

test("record-lock: map drains to zero after idle", async () => {
  const lock = createRecordLock();
  await lock.withLock("k", async () => {});
  // Yield once so any finally-clause microtasks settle.
  await Promise.resolve();
  assert.equal(lock.size(), 0);
});

test("record-lock: map stays populated while operations are queued, drains after", async () => {
  const lock = createRecordLock();

  const p1 = lock.withLock("k", async () => {
    await delay(20);
  });
  const p2 = lock.withLock("k", async () => {
    await delay(20);
  });

  // After both calls are queued but before either resolves, exactly one entry
  // exists for "k" (the latest tail).
  assert.equal(lock.size(), 1);

  await Promise.all([p1, p2]);
  await Promise.resolve();

  assert.equal(lock.size(), 0);
});

test("record-lock: withLock returns the fn's resolved value", async () => {
  const lock = createRecordLock();
  const value = await lock.withLock("k", async () => 42);
  assert.equal(value, 42);
});

test("record-lock: 1000 concurrent calls across 50 keys preserve per-key order", async () => {
  const lock = createRecordLock();
  const N_KEYS = 50;
  const N_OPS = 1000;
  const perKey: Record<string, number[]> = {};
  for (let i = 0; i < N_KEYS; i += 1) perKey[`k${i}`] = [];

  const calls: Promise<unknown>[] = [];
  for (let seq = 0; seq < N_OPS; seq += 1) {
    const key = `k${seq % N_KEYS}`;
    calls.push(
      lock.withLock(key, async () => {
        // Tiny random delay to make interleaving possible if the lock fails.
        await delay(Math.random() * 2);
        perKey[key].push(seq);
      }),
    );
  }

  await Promise.all(calls);

  // Within each key, the recorded sequence numbers must be in strictly
  // increasing order — the same order in which we called `withLock(key, ...)`.
  for (const key of Object.keys(perKey)) {
    const seq = perKey[key];
    for (let i = 1; i < seq.length; i += 1) {
      assert.ok(
        seq[i] > seq[i - 1],
        `key ${key}: out-of-order at index ${i}: ${seq[i - 1]} then ${seq[i]}`,
      );
    }
  }

  await Promise.resolve();
  assert.equal(lock.size(), 0);
});
