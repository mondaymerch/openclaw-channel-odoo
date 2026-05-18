/**
 * Tests for src/inbox/store.ts.
 *
 * Run:   npx tsx --test tests/store.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureInboxQueueDirs,
  findBatchContainingMessage,
  findOpenBatchForRecord,
  listBatches,
  moveBatchToFailed,
  mutateBatch,
  readBatch,
  resolveInboxQueuePaths,
  resolveStateDir,
  unlinkBatch,
  writeBatch,
} from "../src/inbox/store.js";
import type { InboxBatch } from "../src/inbox/types.js";

async function makeTempPaths() {
  const dir = await mkdtemp(join(tmpdir(), "odoo-inbox-store-"));
  const paths = resolveInboxQueuePaths(dir);
  await ensureInboxQueueDirs(paths);
  return { dir, paths };
}

function sampleBatch(overrides: Partial<InboxBatch> = {}): InboxBatch {
  return {
    batchKey: "batch-abc",
    state: "received",
    model: "crm.lead",
    res_id: 106665,
    routing_key: null,
    messages: [
      {
        message_id: 741,
        body: "Hello",
        user_name: "Sila",
        partner_id: 5432,
        receivedAt: 1000,
      },
    ],
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

// ---- Path resolution ----

test("resolveStateDir: respects OPENCLAW_STATE_DIR over OPENCLAW_HOME and HOME", () => {
  const prev = {
    state: process.env.OPENCLAW_STATE_DIR,
    home: process.env.OPENCLAW_HOME,
  };
  try {
    process.env.OPENCLAW_STATE_DIR = "/some/state";
    process.env.OPENCLAW_HOME = "/should-not-win";
    assert.equal(resolveStateDir(), "/some/state");
  } finally {
    process.env.OPENCLAW_STATE_DIR = prev.state;
    process.env.OPENCLAW_HOME = prev.home;
  }
});

test("resolveStateDir: falls back to OPENCLAW_HOME/.openclaw when STATE_DIR is unset", () => {
  const prev = {
    state: process.env.OPENCLAW_STATE_DIR,
    home: process.env.OPENCLAW_HOME,
  };
  try {
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_HOME = "/custom-home";
    assert.equal(resolveStateDir(), "/custom-home/.openclaw");
  } finally {
    process.env.OPENCLAW_STATE_DIR = prev.state;
    process.env.OPENCLAW_HOME = prev.home;
  }
});

test("resolveInboxQueuePaths: builds queueDir and failedDir under stateDir", () => {
  const paths = resolveInboxQueuePaths("/state");
  assert.equal(paths.queueDir, "/state/odoo-inbound-queue");
  assert.equal(paths.failedDir, "/state/odoo-inbound-queue/failed");
});

test("ensureInboxQueueDirs: creates both dirs idempotently", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    // Already created by makeTempPaths; call again, should not throw.
    await ensureInboxQueueDirs(paths);
    const root = await readdir(paths.queueDir, { withFileTypes: true });
    assert.ok(root.some((d) => d.isDirectory() && d.name === "failed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Core CRUD ----

test("writeBatch + readBatch: round-trip preserves all fields", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    const batch = sampleBatch();
    await writeBatch(paths, batch);
    const read = await readBatch(paths, "batch-abc");
    assert.deepEqual(read, batch);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readBatch: missing file returns null", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    assert.equal(await readBatch(paths, "nonexistent"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readBatch: corrupt JSON throws (so callers can decide)", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    // File name follows the schema so locateBatchFile finds it.
    await writeFile(
      join(paths.queueDir, "crm.lead__106665__bad.json"),
      "{not json",
      "utf8",
    );
    await assert.rejects(() => readBatch(paths, "bad"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unlinkBatch: removes existing file", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch());
    await unlinkBatch(paths, "batch-abc");
    assert.equal(await readBatch(paths, "batch-abc"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unlinkBatch: missing file is a no-op (does not throw)", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await unlinkBatch(paths, "never-existed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("moveBatchToFailed: relocates file from queueDir to failedDir", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch());
    await moveBatchToFailed(paths, "batch-abc");
    assert.equal(await readBatch(paths, "batch-abc"), null);
    const failed = await readdir(paths.failedDir);
    assert.deepEqual(failed, ["crm.lead__106665__batch-abc.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("moveBatchToFailed: missing file is a no-op", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await moveBatchToFailed(paths, "never-existed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Scan ----

test("listBatches: returns all batches in queueDir", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch({ batchKey: "a" }));
    await writeBatch(paths, sampleBatch({ batchKey: "b" }));
    const batches = await listBatches(paths);
    const keys = batches.map((b) => b.batchKey).sort();
    assert.deepEqual(keys, ["a", "b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listBatches: skips tmp files and the failed/ subdir", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch({ batchKey: "real" }));
    // Plant a fake openclaw-style tmp file using the new filename schema.
    await writeFile(
      join(paths.queueDir, "crm.lead__106665__real.json.deadbeef.tmp"),
      "garbage",
      "utf8",
    );
    // Put one batch in failed/; should not appear in listBatches.
    await writeBatch(paths, sampleBatch({ batchKey: "going-down" }));
    await moveBatchToFailed(paths, "going-down");

    const batches = await listBatches(paths);
    const keys = batches.map((b) => b.batchKey).sort();
    assert.deepEqual(keys, ["real"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listBatches: missing dir returns []", async () => {
  const noSuchPaths = resolveInboxQueuePaths("/definitely/not/a/path/xyzzy");
  const batches = await listBatches(noSuchPaths);
  assert.deepEqual(batches, []);
});

test("listBatches: onCorrupt fires for malformed files, scan continues", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch({ batchKey: "good" }));
    await writeFile(join(paths.queueDir, "bad.json"), "not json", "utf8");
    const corrupt: string[] = [];
    const batches = await listBatches(paths, {
      onCorrupt: (file) => corrupt.push(file),
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].batchKey, "good");
    assert.equal(corrupt.length, 1);
    assert.ok(corrupt[0].endsWith("bad.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- findBatchContainingMessage ----

test("findBatchContainingMessage: finds match in active queueDir", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(
      paths,
      sampleBatch({
        batchKey: "a",
        messages: [
          { message_id: 100, body: "x", receivedAt: 0 },
          { message_id: 101, body: "y", receivedAt: 0 },
        ],
      }),
    );
    const hit = await findBatchContainingMessage(paths, 101);
    assert.equal(hit?.batchKey, "a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findBatchContainingMessage: finds match in failed/", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(
      paths,
      sampleBatch({
        batchKey: "dead",
        messages: [{ message_id: 999, body: "x", receivedAt: 0 }],
      }),
    );
    await moveBatchToFailed(paths, "dead");
    const hit = await findBatchContainingMessage(paths, 999);
    assert.equal(hit?.batchKey, "dead");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findBatchContainingMessage: returns null when nothing matches", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch());
    const hit = await findBatchContainingMessage(paths, 9999);
    assert.equal(hit, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Composer ----

test("mutateBatch: reads, mutates, writes back, returns updated batch", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch());
    const result = await mutateBatch(paths, "batch-abc", (b) => {
      b.dispatchAttempts = 7;
      b.lastError = "boom";
    });
    assert.equal(result?.dispatchAttempts, 7);
    assert.equal(result?.lastError, "boom");
    const reread = await readBatch(paths, "batch-abc");
    assert.equal(reread?.dispatchAttempts, 7);
    assert.equal(reread?.lastError, "boom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutateBatch: missing file returns null without invoking mutator", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    let called = false;
    const result = await mutateBatch(paths, "nope", () => {
      called = true;
    });
    assert.equal(result, null);
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- findOpenBatchForRecord ----

test("findOpenBatchForRecord: returns the open batch when one exists", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch({ batchKey: "open-1" }));
    const hit = await findOpenBatchForRecord(paths, "crm.lead", 106665, null);
    assert.equal(hit?.batchKey, "open-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findOpenBatchForRecord: null when no batches exist for the record", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch({ batchKey: "elsewhere", model: "sale.order", res_id: 42 }));
    const hit = await findOpenBatchForRecord(paths, "crm.lead", 106665, null);
    assert.equal(hit, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findOpenBatchForRecord: skips batches in state dispatching", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(
      paths,
      sampleBatch({
        batchKey: "in-flight",
        state: "dispatching",
        closedAt: 12345,
        inFlightSince: 12345,
      }),
    );
    const hit = await findOpenBatchForRecord(paths, "crm.lead", 106665, null);
    assert.equal(hit, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findOpenBatchForRecord: skips batches in state reply_ready", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(
      paths,
      sampleBatch({
        batchKey: "delivered",
        state: "reply_ready",
        reply: { text: "hi", producedAt: 1000 },
      }),
    );
    const hit = await findOpenBatchForRecord(paths, "crm.lead", 106665, null);
    assert.equal(hit, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findOpenBatchForRecord: prefix mismatch on res_id is rejected", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    // res_id 1066650 starts with the digits 106665 — the trailing "__" in
    // the prefix prevents it from matching as a substring.
    await writeBatch(
      paths,
      sampleBatch({ batchKey: "near-miss", res_id: 1066650 }),
    );
    const hit = await findOpenBatchForRecord(paths, "crm.lead", 106665, null);
    assert.equal(hit, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findOpenBatchForRecord: null when the only batch for that record lives in failed/", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch({ batchKey: "dead-1" }));
    await moveBatchToFailed(paths, "dead-1");
    const hit = await findOpenBatchForRecord(paths, "crm.lead", 106665, null);
    assert.equal(hit, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findOpenBatchForRecord: tolerates a corrupt file with matching prefix", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeBatch(paths, sampleBatch({ batchKey: "good" }));
    // Plant a corrupt file matching the same record's prefix.
    await writeFile(
      join(paths.queueDir, "crm.lead__106665__bad.json"),
      "{not json",
      "utf8",
    );
    const hit = await findOpenBatchForRecord(paths, "crm.lead", 106665, null);
    assert.equal(hit?.batchKey, "good");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Migration: readBatch normalizes legacy on-disk shape (with
// dispatchedAt) to the new shape (with closedAt + inFlightSince).
// Three disambiguation cases tested.
// ============================================================

async function writeLegacyFile(
  paths: ReturnType<typeof resolveInboxQueuePaths>,
  filename: string,
  legacy: object,
) {
  await writeFile(
    join(paths.queueDir, filename),
    JSON.stringify(legacy),
    "utf8",
  );
}

test("Migration M1: legacy batch dispatchedAt=null → closedAt=null, inFlightSince=null", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeLegacyFile(paths, "crm.lead__106665__fresh.json", {
      batchKey: "fresh",
      state: "received",
      model: "crm.lead",
      res_id: 106665,
      messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
      enqueuedAt: 1000,
      dispatchedAt: null,
      dispatchAttempts: 0,
      deliveryAttempts: 0,
      lastAttemptAt: null,
      lastError: null,
      lastFailureClass: null,
      reply: null,
    });
    const b = await readBatch(paths, "fresh");
    assert.ok(b);
    assert.equal(b!.closedAt, null);
    assert.equal(b!.inFlightSince, null);
    assert.equal(b!.state, "received");
    assert.equal("dispatchedAt" in b!, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Migration M2: legacy received batch with dispatchedAt + recorded failure → 'received in backoff' (state preserved, inFlightSince=null)", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeLegacyFile(paths, "crm.lead__106665__backoff.json", {
      batchKey: "backoff",
      state: "received",
      model: "crm.lead",
      res_id: 106665,
      messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
      enqueuedAt: 1000,
      dispatchedAt: 2000,
      dispatchAttempts: 1,
      deliveryAttempts: 0,
      lastAttemptAt: 3000,             // failure AFTER dispatchedAt
      lastError: "agent went silent",
      lastFailureClass: "silent",
      reply: null,
    });
    const b = await readBatch(paths, "backoff");
    assert.ok(b);
    assert.equal(b!.state, "received");
    assert.equal(b!.closedAt, 2000);       // preserved from legacy dispatchedAt
    assert.equal(b!.inFlightSince, null);  // failure recorded → not in flight
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Migration M2b: lastAttemptAt === dispatchedAt boundary → 'received in backoff' (>= predicate)", async () => {
  // The normalizer's predicate is `lastAttemptAt >= dispatchedAt`. M2
  // covered the strictly-greater case; this covers the boundary.
  // A regression to strict `>` would flip the result to "dispatching".
  const { dir, paths } = await makeTempPaths();
  try {
    await writeLegacyFile(paths, "crm.lead__106665__boundary.json", {
      batchKey: "boundary",
      state: "received",
      model: "crm.lead",
      res_id: 106665,
      messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
      enqueuedAt: 1000,
      dispatchedAt: 2000,
      dispatchAttempts: 1,
      deliveryAttempts: 0,
      lastAttemptAt: 2000,           // EXACTLY equal to dispatchedAt
      lastError: "boundary",
      lastFailureClass: "silent",
      reply: null,
    });
    const b = await readBatch(paths, "boundary");
    assert.ok(b);
    assert.equal(b!.state, "received");        // NOT "dispatching"
    assert.equal(b!.closedAt, 2000);
    assert.equal(b!.inFlightSince, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Migration M3: legacy received batch with dispatchedAt + no failure → crashed mid-dispatch, state=dispatching", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeLegacyFile(paths, "crm.lead__106665__crashed.json", {
      batchKey: "crashed",
      state: "received",
      model: "crm.lead",
      res_id: 106665,
      messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
      enqueuedAt: 1000,
      dispatchedAt: 2000,
      dispatchAttempts: 0,
      deliveryAttempts: 0,
      lastAttemptAt: null,             // no failure recorded
      lastError: null,
      lastFailureClass: null,
      reply: null,
    });
    const b = await readBatch(paths, "crashed");
    assert.ok(b);
    assert.equal(b!.state, "dispatching");
    assert.equal(b!.closedAt, 2000);
    assert.equal(b!.inFlightSince, 2000);  // was in flight at crash
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Migration M4: legacy reply_ready batch with dispatchedAt → closedAt set, inFlightSince=null", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    await writeLegacyFile(paths, "crm.lead__106665__rr.json", {
      batchKey: "rr",
      state: "reply_ready",
      model: "crm.lead",
      res_id: 106665,
      messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
      enqueuedAt: 1000,
      dispatchedAt: 2000,
      dispatchAttempts: 0,
      deliveryAttempts: 0,
      lastAttemptAt: null,
      lastError: null,
      lastFailureClass: null,
      reply: { text: "agent answer", producedAt: 3000 },
    });
    const b = await readBatch(paths, "rr");
    assert.ok(b);
    assert.equal(b!.state, "reply_ready");
    assert.equal(b!.closedAt, 2000);
    assert.equal(b!.inFlightSince, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Migration M5: normalizer is idempotent — already-new shape passes through unchanged", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    const newShape = sampleBatch({ batchKey: "new", closedAt: 1234, inFlightSince: 5678, state: "dispatching" });
    await writeBatch(paths, newShape);
    const b = await readBatch(paths, "new");
    assert.deepEqual(b, newShape);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Migration: pre-routing_key batch JSON loads with routing_key=null (backwards-compat)", async () => {
  const { dir, paths } = await makeTempPaths();
  try {
    // Write a JSON shape lacking the routing_key field — simulates a batch
    // serialized by a pre-feature version of the plugin.
    const oldShape = {
      batchKey: "legacy",
      state: "received",
      model: "crm.lead",
      res_id: 106665,
      messages: [
        {
          message_id: 999,
          body: "hi",
          receivedAt: 1000,
        },
      ],
      enqueuedAt: 1000,
      closedAt: null,
      inFlightSince: null,
      dispatchAttempts: 0,
      deliveryAttempts: 0,
      lastAttemptAt: null,
      lastError: null,
      lastFailureClass: null,
      reply: null,
      // intentionally NO routing_key
    };
    await writeFile(
      join(paths.queueDir, "crm.lead__106665__legacy.json"),
      JSON.stringify(oldShape),
      "utf8",
    );
    const b = await readBatch(paths, "legacy");
    assert.ok(b);
    assert.equal(b!.routing_key, null);
    // Other fields unchanged
    assert.equal(b!.state, "received");
    assert.equal(b!.messages.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
