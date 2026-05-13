/**
 * Tests for src/webhook-handler.ts — createWebhookHandler.
 *
 * Scope: covers the new branches introduced by the persistent inbox
 * wiring (queue.appendOrCreateBatch outcomes + the ready-gate). The
 * auth / body-parse / validation branches are unchanged and not
 * re-tested here.
 *
 * Run: npx tsx --test tests/webhook-handler.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createDedupeCache } from "openclaw/plugin-sdk/infra-runtime";

import { createWebhookHandler } from "../src/webhook-handler.js";
import type { PluginApi, InboundMessage } from "../src/dispatch.js";
import type {
  AppendOrCreateInput,
  AppendOrCreateResult,
  InboxQueue,
} from "../src/inbox/queue.js";

// ---- Fakes ---------------------------------------------------------------

const WEBHOOK_SECRET = "test-secret";

function makeConfig(): PluginApi["config"] {
  return {
    channels: {
      odoo: { webhookSecret: WEBHOOK_SECRET },
    },
  } as unknown as PluginApi["config"];
}

function makeLogger() {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    logger: { info: (m: string) => infos.push(m), error: (m: string) => errors.push(m) },
    infos,
    errors,
  };
}

function makeApi(): { api: PluginApi; infos: string[]; errors: string[] } {
  const { logger, infos, errors } = makeLogger();
  return { api: { config: makeConfig(), logger }, infos, errors };
}

type DedupeStub = {
  check: (key: string | undefined | null) => boolean;
  delete: (key: string | undefined | null) => void;
};
function makeDedupe(opts: { hits?: boolean } = {}): DedupeStub & {
  checkCalls: string[];
  deleteCalls: string[];
} {
  const checkCalls: string[] = [];
  const deleteCalls: string[] = [];
  return {
    checkCalls,
    deleteCalls,
    check(key) {
      checkCalls.push(String(key));
      return opts.hits === true;
    },
    delete(key) {
      deleteCalls.push(String(key));
    },
  };
}

type DebouncerStub = { enqueue: (item: InboundMessage) => Promise<void> } & {
  calls: InboundMessage[];
};
function makeDebouncer(): DebouncerStub {
  const calls: InboundMessage[] = [];
  return {
    calls,
    async enqueue(item) {
      calls.push(item);
    },
  };
}

function makeQueue(
  result: AppendOrCreateResult,
): InboxQueue & { calls: AppendOrCreateInput[] } {
  const calls: AppendOrCreateInput[] = [];
  return {
    calls,
    async appendOrCreateBatch(input) {
      calls.push(input);
      return result;
    },
    // Unused in these tests — typed for compilation only.
    async markDispatching() {
      throw new Error("not used");
    },
    async transitionToReplyReady() {
      throw new Error("not used");
    },
    async recordDeliverySuccess() {
      throw new Error("not used");
    },
    async recordFailure() {
      throw new Error("not used");
    },
    async moveBatchToFailed() {
      throw new Error("not used");
    },
  } as InboxQueue & { calls: AppendOrCreateInput[] };
}

function makeReqRes(opts: { auth?: string; body: object }) {
  const bodyStr = JSON.stringify(opts.body);
  const buf = Buffer.from(bodyStr);
  const stream = Readable.from([buf]) as unknown as IncomingMessage;
  // Headers + minimal IncomingMessage shape readJsonBodyWithLimit reads.
  Object.assign(stream, {
    headers: {
      authorization: opts.auth ?? `Bearer ${WEBHOOK_SECRET}`,
      "content-length": String(buf.length),
      "content-type": "application/json",
    },
    method: "POST",
  });

  let statusCode = 0;
  let body = "";
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    setHeader() {},
    end(chunk?: string) {
      if (chunk) body = chunk;
    },
  } as unknown as ServerResponse;

  return {
    req: stream,
    res,
    getStatus: () => statusCode,
    getBody: () => (body ? JSON.parse(body) : {}),
  };
}

function validBody(overrides: Partial<{
  model: string;
  res_id: number;
  message_id: number;
  body: string;
  user_name: string;
  partner_id: number;
}> = {}) {
  return {
    model: "crm.lead",
    res_id: 42,
    message_id: 1001,
    body: "hi",
    user_name: "Alice",
    partner_id: 7,
    ...overrides,
  };
}

// ============================================================
// E2-T1: ok+create → 202, debouncer.enqueue called once
// ============================================================

test("E2-T1: ok+didCreate=true → 202 with batchKey, debouncer.enqueue called once", async () => {
  const { api } = makeApi();
  const dedupe = makeDedupe();
  const debouncer = makeDebouncer();
  const queue = makeQueue({ ok: true, batchKey: "abc", didCreate: true });
  const handler = createWebhookHandler({
    api,
    dedupe,
    debouncer,
    queue,
    isReady: () => true,
  });

  const { req, res, getStatus, getBody } = makeReqRes({ body: validBody() });
  await handler(req, res);

  assert.equal(getStatus(), 202);
  const body = getBody();
  assert.equal(body.accepted, true);
  assert.equal(body.batchKey, "abc");
  assert.equal(queue.calls.length, 1);
  assert.equal(queue.calls[0].message_id, 1001);
  assert.equal(debouncer.calls.length, 1);
  assert.equal(debouncer.calls[0].message_id, 1001);
});

// ============================================================
// E2-T2: ok+!didCreate → 202, debouncer.enqueue still called
// ============================================================

test("E2-T2: ok+didCreate=false → 202, debouncer.enqueue still called (extends window)", async () => {
  const { api } = makeApi();
  const dedupe = makeDedupe();
  const debouncer = makeDebouncer();
  const queue = makeQueue({ ok: true, batchKey: "abc", didCreate: false });
  const handler = createWebhookHandler({
    api,
    dedupe,
    debouncer,
    queue,
    isReady: () => true,
  });

  const { req, res, getStatus } = makeReqRes({ body: validBody({ message_id: 1002 }) });
  await handler(req, res);

  assert.equal(getStatus(), 202);
  assert.equal(debouncer.calls.length, 1);
  assert.equal(debouncer.calls[0].message_id, 1002);
});

// ============================================================
// E2-T3: disk-duplicate → 202 with duplicate flag, no enqueue
// ============================================================

test("E2-T3: disk-level duplicate → 202 duplicate flag, debouncer.enqueue NOT called", async () => {
  const { api, infos } = makeApi();
  const dedupe = makeDedupe();
  const debouncer = makeDebouncer();
  const queue = makeQueue({
    ok: false,
    reason: "duplicate",
    existingBatchKey: "existing",
  });
  const handler = createWebhookHandler({
    api,
    dedupe,
    debouncer,
    queue,
    isReady: () => true,
  });

  const { req, res, getStatus, getBody } = makeReqRes({ body: validBody() });
  await handler(req, res);

  assert.equal(getStatus(), 202);
  assert.equal(getBody().duplicate, true);
  assert.equal(debouncer.calls.length, 0);
  const note = infos.find((m) => m.includes("Disk-duplicate"));
  assert.ok(note);
});

// ============================================================
// E2-T4: disk_error → 503, no enqueue, error logged
// ============================================================

test("E2-T4: disk_error → 503, debouncer.enqueue NOT called, error logged", async () => {
  const { api, errors } = makeApi();
  const dedupe = makeDedupe();
  const debouncer = makeDebouncer();
  const queue = makeQueue({
    ok: false,
    reason: "disk_error",
    error: new Error("ENOSPC: no space left"),
  });
  const handler = createWebhookHandler({
    api,
    dedupe,
    debouncer,
    queue,
    isReady: () => true,
  });

  const { req, res, getStatus } = makeReqRes({ body: validBody() });
  await handler(req, res);

  assert.equal(getStatus(), 503);
  assert.equal(debouncer.calls.length, 0);
  const log = errors.find(
    (m) => m.includes("disk_error") && m.includes("ENOSPC"),
  );
  assert.ok(log);
  // Critical: the dedup mark from the earlier check() must be rolled
  // back so Odoo's retry can re-attempt persistence (otherwise the
  // retry hits the cache and the message is silently lost).
  assert.deepEqual(dedupe.deleteCalls, ["1001"]);
});

// ============================================================
// E2-T5: in-memory dedup hit → 202, no queue write, no enqueue
// ============================================================

test("E2-T5: in-memory dedup hit short-circuits → no queue write, no enqueue", async () => {
  const { api } = makeApi();
  const dedupe = makeDedupe({ hits: true });
  const debouncer = makeDebouncer();
  const queue = makeQueue({ ok: true, batchKey: "abc", didCreate: true });
  const handler = createWebhookHandler({
    api,
    dedupe,
    debouncer,
    queue,
    isReady: () => true,
  });

  const { req, res, getStatus, getBody } = makeReqRes({ body: validBody() });
  await handler(req, res);

  assert.equal(getStatus(), 202);
  assert.equal(getBody().duplicate, true);
  assert.equal(queue.calls.length, 0);
  assert.equal(debouncer.calls.length, 0);
});

// ============================================================
// E3-T4: not-ready → 503, no queue write, no enqueue
// ============================================================

test("E3-T4: ready-gate closed → 503, queue.appendOrCreateBatch NOT called", async () => {
  const { api } = makeApi();
  const dedupe = makeDedupe();
  const debouncer = makeDebouncer();
  const queue = makeQueue({ ok: true, batchKey: "abc", didCreate: true });
  const handler = createWebhookHandler({
    api,
    dedupe,
    debouncer,
    queue,
    isReady: () => false,
  });

  const { req, res, getStatus } = makeReqRes({ body: validBody() });
  await handler(req, res);

  assert.equal(getStatus(), 503);
  assert.equal(queue.calls.length, 0);
  assert.equal(debouncer.calls.length, 0);
});

// ============================================================
// E2-T6: disk_error followed by Odoo retry → second call persists
// (regression test for the memory-dedup poisoning bug — uses a REAL
// createDedupeCache because the bug is in the SDK's check() side-effect
// semantics; a constant-return stub can't reproduce it.)
// ============================================================

test("E2-T6: disk_error rolls back dedup mark; Odoo retry persists (no silent loss)", async () => {
  const { api } = makeApi();
  const debouncer = makeDebouncer();

  const realDedupe = createDedupeCache({ ttlMs: 60_000, maxSize: 100 });

  let queueCallCount = 0;
  const queueCalls: AppendOrCreateInput[] = [];
  const queue = {
    async appendOrCreateBatch(
      input: AppendOrCreateInput,
    ): Promise<AppendOrCreateResult> {
      queueCalls.push(input);
      queueCallCount += 1;
      if (queueCallCount === 1) {
        return {
          ok: false,
          reason: "disk_error",
          error: new Error("ENOSPC: no space left"),
        };
      }
      return { ok: true, batchKey: "persisted-on-retry", didCreate: true };
    },
    async markDispatching() { throw new Error("not used"); },
    async transitionToReplyReady() { throw new Error("not used"); },
    async recordDeliverySuccess() { throw new Error("not used"); },
    async recordFailure() { throw new Error("not used"); },
    async moveBatchToFailed() { throw new Error("not used"); },
  } as unknown as InboxQueue;

  const handler = createWebhookHandler({
    api,
    dedupe: realDedupe,
    debouncer,
    queue,
    isReady: () => true,
  });

  // First call: disk write fails → 503.
  const a = makeReqRes({ body: validBody({ message_id: 42 }) });
  await handler(a.req, a.res);
  assert.equal(a.getStatus(), 503);

  // Odoo retries with the SAME message_id. Without the rollback fix,
  // this would short-circuit on the lingering dedup mark and respond
  // 202+duplicate without persisting (silent loss).
  const b = makeReqRes({ body: validBody({ message_id: 42 }) });
  await handler(b.req, b.res);
  assert.equal(b.getStatus(), 202);
  const body = b.getBody();
  assert.equal(body.accepted, true);
  // CRITICAL: must NOT be a duplicate response — the disk_error
  // rolled back the mark so the retry proceeds to the queue.
  assert.notEqual(body.duplicate, true);
  assert.equal(body.batchKey, "persisted-on-retry");

  // Queue actually called twice (failure + success), confirming the
  // retry path wasn't short-circuited by the dedup cache.
  assert.equal(queueCalls.length, 2);
  assert.equal(debouncer.calls.length, 1);
  assert.equal(debouncer.calls[0].message_id, 42);
});
