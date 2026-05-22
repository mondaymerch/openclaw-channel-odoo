/**
 * Tests for src/dispatch.ts — createDispatchHandler.
 *
 * Scope: covers the reply_ready branch and the no-route case. The full
 * "received → openclaw dispatch → deliver" path requires mocking the
 * openclaw runtime, which is deferred to F's end-to-end tests.
 *
 * Run: npx tsx --test tests/dispatch.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDispatchHandler,
  type CreateDispatchHandlerDeps,
  type PluginApi,
} from "../src/dispatch.js";
import type {
  CompiledRoute,
  ResolvedOdooAccount,
} from "../src/channel.js";
import type { CallReplyParams, OdooConfig } from "../src/client.js";
import {
  createInboxQueue,
  type BatchRef,
  type InboxQueue,
  type MarkDispatchingResult,
} from "../src/inbox/queue.js";
import { createRecordLock } from "../src/inbox/record-lock.js";
import { createRetryScheduler } from "../src/inbox/scheduler.js";
import {
  ensureInboxQueueDirs,
  readBatch,
  resolveInboxQueuePaths,
  writeBatch,
} from "../src/inbox/store.js";
import {
  DELIVERY_BACKOFF_MS,
  DISPATCH_BACKOFF_MS,
  type InboxBatch,
} from "../src/inbox/types.js";

// ---- Fake timers (shared shape with scheduler.test.ts) ----

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

function makeRoute(model: string, overrides: Partial<CompiledRoute> = {}): CompiledRoute {
  return {
    match: { kind: "model", regex: new RegExp(`^${model}$`), pattern: model },
    reply: {
      method: "openclaw_post_reply",
      args: ["body", "requestMessageId"],
      kwargs: {},
    },
    promptHeader: true,
    source: "test",
    ...overrides,
  } as unknown as CompiledRoute;
}

function makeAccount(routes: CompiledRoute[]): ResolvedOdooAccount {
  return {
    accountId: "default",
    url: "http://test.invalid",
    db: "test",
    uid: 1,
    password: "secret",
    webhookSecret: "secret",
    webhookPath: "/odoo/inbound",
    allowFrom: [],
    botSessionId: "bot-session",
    routes,
  } as ResolvedOdooAccount;
}

async function makeDispatchHarness(opts: {
  routes?: CompiledRoute[];
  callReply?: (p: CallReplyParams) => Promise<unknown>;
  /** Override markDispatching to test the CAS loser branch in processBatch. */
  markDispatchingOverride?: (ref: BatchRef) => Promise<MarkDispatchingResult>;
  getRuntime?: CreateDispatchHandlerDeps["getRuntime"];
  hardTimeoutMs?: number;
  now?: () => number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "odoo-dispatch-handler-"));
  const paths = resolveInboxQueuePaths(dir);
  await ensureInboxQueueDirs(paths);

  const lock = createRecordLock();
  const realQueue = createInboxQueue({ paths, lock });
  const queue: InboxQueue = opts.markDispatchingOverride
    ? { ...realQueue, markDispatching: opts.markDispatchingOverride }
    : realQueue;

  const callReplyCalls: CallReplyParams[] = [];
  const callReplyImpl = opts.callReply ?? (async () => undefined);
  const wrappedCallReply: (p: CallReplyParams) => Promise<unknown> = async (p) => {
    callReplyCalls.push(p);
    return callReplyImpl(p);
  };

  const fakeTimers = makeFakeTimers();
  const logger = makeLogger();

  const scheduler = createRetryScheduler({
    paths,
    queue,
    processBatch: async () => {},
    logger: logger.logger,
    setTimer: fakeTimers.setTimer,
    clearTimer: fakeTimers.clearTimer,
  });

  const api: PluginApi = {
    config: {} as never,
    logger: logger.logger,
  };

  const account = makeAccount(opts.routes ?? [makeRoute("crm.lead")]);
  const clientConfig: OdooConfig = {
    url: account.url,
    db: account.db,
    uid: account.uid,
    password: account.password,
  };

  const deps: CreateDispatchHandlerDeps = {
    api,
    account,
    clientConfig,
    queue,
    scheduler,
    hardTimeoutMs: opts.hardTimeoutMs,
    now: opts.now,
    getClient: () => ({ callReply: wrappedCallReply }),
    getRuntime: opts.getRuntime,
  };

  const handler = createDispatchHandler(deps);
  return { dir, paths, queue, scheduler, fakeTimers, logger, handler, account, callReplyCalls };
}

function makeReplyReadyBatch(overrides: Partial<InboxBatch> & { batchKey: string }): InboxBatch {
  return {
    batchKey: overrides.batchKey,
    state: "reply_ready",
    model: "crm.lead",
    res_id: 106665,
    messages: [{ message_id: 741, body: "hi", receivedAt: 1000 }],
    enqueuedAt: 1000,
    closedAt: 2000,
    inFlightSince: null,
    dispatchAttempts: 0,
    deliveryAttempts: 0,
    lastAttemptAt: null,
    lastError: null,
    lastFailureClass: null,
    reply: { text: "agent reply text", producedAt: 3000 },
    ...overrides,
  };
}

const refOf = (batch: InboxBatch): BatchRef => ({
  model: batch.model,
  res_id: batch.res_id,
  batchKey: batch.batchKey,
  routing_key: batch.routing_key,
});

// ============================================================
// E1-T1: reply_ready + successful callReply → recordDeliverySuccess
// ============================================================

test("E1-T1: reply_ready branch with successful callReply unlinks the batch", async () => {
  const { dir, paths, fakeTimers, handler, callReplyCalls } =
    await makeDispatchHarness();
  try {
    const batch = makeReplyReadyBatch({ batchKey: "abc" });
    await writeBatch(paths, batch);

    await handler.processBatch(batch);

    // File unlinked
    assert.equal(await readBatch(paths, "abc"), null);
    // No retry scheduled
    assert.equal(fakeTimers.pending.length, 0);
    // callReply called exactly once with the saved text
    assert.equal(callReplyCalls.length, 1);
    assert.equal(callReplyCalls[0].body, "agent reply text");
    assert.equal(callReplyCalls[0].model, "crm.lead");
    assert.equal(callReplyCalls[0].resId, 106665);
    assert.equal(callReplyCalls[0].requestMessageId, 741);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E1-T2: reply_ready + throwing callReply → handleFailure(xmlrpc_failure)
// ============================================================

test("E1-T2: reply_ready branch with throwing callReply schedules xmlrpc retry", async () => {
  const { dir, paths, fakeTimers, handler } = await makeDispatchHarness({
    callReply: async () => {
      throw new Error("503 from odoo");
    },
  });
  try {
    const batch = makeReplyReadyBatch({ batchKey: "abc" });
    await writeBatch(paths, batch);

    await handler.processBatch(batch);

    // File still in queueDir; reply.text MUST be preserved — the whole
    // point of reply_ready is to skip the agent run on retry. A bug that
    // wiped reply.text on xmlrpc_failure would silently let the next
    // retry re-enter the agent path.
    const current = await readBatch(paths, "abc");
    assert.ok(current);
    assert.equal(current!.state, "reply_ready");
    assert.equal(current!.reply?.text, "agent reply text");
    assert.equal(current!.deliveryAttempts, 1);
    assert.equal(current!.lastFailureClass, "xmlrpc_failure");

    // Scheduler scheduled a retry at DELIVERY_BACKOFF_MS[0] (5000ms)
    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, DELIVERY_BACKOFF_MS[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E1-T3: no matching route → handleFailure(internal_error)
// ============================================================

test("E1-T3: no matching route → handleFailure(internal_error), counter bumped", async () => {
  const { dir, paths, fakeTimers, handler, logger } = await makeDispatchHarness({
    // Account has no routes at all — every model will miss.
    routes: [],
  });
  try {
    const batch = makeReplyReadyBatch({
      batchKey: "abc",
      model: "no.such.model",
      state: "received",
      reply: null,
    });
    await writeBatch(paths, batch);

    await handler.processBatch(batch);

    // Counter bumped via recordFailure
    const current = await readBatch(paths, "abc");
    assert.ok(current);
    assert.equal(current!.dispatchAttempts, 1);
    assert.equal(current!.lastFailureClass, "internal_error");
    assert.ok(current!.lastError?.includes("no route"));

    // First failure → scheduler scheduled a retry (not abandoned yet)
    assert.equal(fakeTimers.pending.length, 1);

    // Error logged
    const noRouteLog = logger.errors.find((m) => m.includes("no route for model"));
    assert.ok(noRouteLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E1-T4: CAS loser (not_received) → processBatch returns early
// ============================================================

test("E1-T4: markDispatching returns not_received → no agent, no callReply, no handleFailure", async () => {
  const { dir, paths, fakeTimers, handler, logger, callReplyCalls } =
    await makeDispatchHarness({
      markDispatchingOverride: async () => ({
        ok: false,
        reason: "not_received",
      }),
    });
  try {
    // Seed a fresh "received" batch. The override will reject the CAS.
    const batch: InboxBatch = {
      batchKey: "abc",
      state: "received",
      model: "crm.lead",
      res_id: 106665,
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
    };
    await writeBatch(paths, batch);
    const snapshot = await readBatch(paths, "abc");

    await handler.processBatch(batch);

    // No agent dispatch happened. No XML-RPC. No retry scheduled.
    assert.equal(callReplyCalls.length, 0);
    assert.equal(fakeTimers.pending.length, 0);

    // File on disk is unchanged — the loser branch must not write.
    const after = await readBatch(paths, "abc");
    assert.deepEqual(after, snapshot);

    // Loser branch logs an info line so operations can spot dropped fires.
    const skipLog = logger.infos.find(
      (m) => m.includes("skipping dispatch") && m.includes("not_received"),
    );
    assert.ok(skipLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E1-T5: CAS loser (missing) → processBatch returns early
// ============================================================

test("E1-T5: markDispatching returns missing → no agent, no callReply, no handleFailure", async () => {
  const { dir, paths, fakeTimers, handler, logger, callReplyCalls } =
    await makeDispatchHarness({
      markDispatchingOverride: async () => ({ ok: false, reason: "missing" }),
    });
  try {
    const batch: InboxBatch = {
      batchKey: "abc",
      state: "received",
      model: "crm.lead",
      res_id: 106665,
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
    };
    await writeBatch(paths, batch);

    await handler.processBatch(batch);

    assert.equal(callReplyCalls.length, 0);
    assert.equal(fakeTimers.pending.length, 0);
    const skipLog = logger.infos.find(
      (m) => m.includes("skipping dispatch") && m.includes("missing"),
    );
    assert.ok(skipLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E1-T5b: received branch forces automatic delivery for Odoo XML-RPC
// ============================================================

test("E1-T5b: received branch uses automatic source delivery and posts final reply", async () => {
  const dispatchCalls: Array<{
    replyOptions?: { sourceReplyDeliveryMode?: string };
    bodyForAgent?: string;
  }> = [];

  const { dir, paths, fakeTimers, handler, callReplyCalls } =
    await makeDispatchHarness({
      routes: [
        makeRoute("purchase.order", {
          match: {
            kind: "model",
            regex: /^purchase\.order$/,
            pattern: "purchase.order",
          },
          agentId: "purchase-scheduled-date",
          reply: {
            method: "scheduled_date_response",
            args: ["body", "requestMessageId"],
            kwargs: {},
          },
        } as Partial<CompiledRoute>),
      ],
      getRuntime: () => ({
        channel: {
          routing: {
            resolveAgentRoute: () => ({
              agentId: "public",
              sessionKey: "agent:public:odoo:direct:purchase.order:39269",
              mainSessionKey: "agent:public",
            }),
          },
          reply: {
            finalizeInboundContext: (ctx: { BodyForAgent?: string }) => ctx,
            dispatchReplyWithBufferedBlockDispatcher: async (params: {
              ctx: { BodyForAgent?: string };
              dispatcherOptions: {
                deliver: (payload: { text?: string }) => Promise<void>;
              };
              replyOptions?: { sourceReplyDeliveryMode?: string };
            }) => {
              dispatchCalls.push({
                replyOptions: params.replyOptions,
                bodyForAgent: params.ctx.BodyForAgent,
              });
              await params.dispatcherOptions.deliver({
                text: "{\"is_scheduled_date_response\":true,\"scheduled_date\":\"2026-06-18\"}",
              });
              return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
            },
          },
          session: {
            resolveStorePath: () => "/tmp/openclaw-test-store",
            recordInboundSession: async () => undefined,
          },
        },
      } as unknown as ReturnType<NonNullable<CreateDispatchHandlerDeps["getRuntime"]>>),
    });
  try {
    const batch: InboxBatch = {
      batchKey: "abc",
      state: "received",
      model: "purchase.order",
      res_id: 39269,
      routing_key: "purchase.receipt.scheduled_date_response",
      messages: [
        {
          message_id: 3569,
          body: "Latest message body: delivery arrives 2026-06-18",
          user_name: "Raven Automation",
          partner_id: 249604,
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
    };
    await writeBatch(paths, batch);

    await handler.processBatch(batch);

    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].replyOptions?.sourceReplyDeliveryMode, "automatic");
    assert.ok(dispatchCalls[0].bodyForAgent?.includes("routing_key="));
    assert.equal(callReplyCalls.length, 1);
    assert.equal(callReplyCalls[0].method, "scheduled_date_response");
    assert.equal(callReplyCalls[0].requestMessageId, 3569);
    assert.equal(await readBatch(paths, "abc"), null);
    assert.equal(fakeTimers.pending.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E1-T6: fresh state="dispatching" branch → still in-flight no-op
// ============================================================

test("E1-T6: fresh state=dispatching reaching processBatch → no side effects", async () => {
  const { dir, paths, fakeTimers, handler, logger, callReplyCalls } =
    await makeDispatchHarness({ now: () => 2_000, hardTimeoutMs: 900_000 });
  try {
    const batch: InboxBatch = {
      batchKey: "abc",
      state: "dispatching",
      model: "crm.lead",
      res_id: 106665,
      messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
      enqueuedAt: 1000,
      closedAt: 1500,
      inFlightSince: 1500,
      dispatchAttempts: 0,
      deliveryAttempts: 0,
      lastAttemptAt: null,
      lastError: null,
      lastFailureClass: null,
      reply: null,
    };
    await writeBatch(paths, batch);
    const snapshot = await readBatch(paths, "abc");

    await handler.processBatch(batch);

    // No agent run, no XML-RPC, no retry, no failure recorded.
    assert.equal(callReplyCalls.length, 0);
    assert.equal(fakeTimers.pending.length, 0);

    // File untouched.
    const after = await readBatch(paths, "abc");
    assert.deepEqual(after, snapshot);

    const skipLog = logger.infos.find((m) =>
      m.includes("state=dispatching") && m.includes("still in flight"),
    );
    assert.ok(skipLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// E1-T7: stale state="dispatching" branch → failure/backoff retry
// ============================================================

test("E1-T7: stale state=dispatching reaching processBatch → normalized and retry scheduled", async () => {
  const { dir, paths, fakeTimers, handler, logger, callReplyCalls } =
    await makeDispatchHarness({ now: () => 20_000, hardTimeoutMs: 10_000 });
  try {
    const batch: InboxBatch = {
      batchKey: "abc",
      state: "dispatching",
      model: "crm.lead",
      res_id: 106665,
      messages: [{ message_id: 1, body: "hi", receivedAt: 1000 }],
      enqueuedAt: 1000,
      closedAt: 1500,
      inFlightSince: 1500,
      dispatchAttempts: 0,
      deliveryAttempts: 0,
      lastAttemptAt: null,
      lastError: null,
      lastFailureClass: null,
      reply: null,
    };
    await writeBatch(paths, batch);

    await handler.processBatch(batch);

    assert.equal(callReplyCalls.length, 0);

    const after = await readBatch(paths, "abc");
    assert.ok(after);
    assert.equal(after!.state, "received");
    assert.equal(after!.inFlightSince, null);
    assert.equal(after!.dispatchAttempts, 1);
    assert.equal(after!.lastFailureClass, "internal_error");
    assert.ok(after!.lastError?.includes("stale dispatching"));

    assert.equal(fakeTimers.pending.length, 1);
    assert.equal(fakeTimers.pending[0].delayMs, DISPATCH_BACKOFF_MS[0]);

    const staleLog = logger.errors.find((m) =>
      m.includes("stale state=dispatching") && m.includes("retrying via backoff"),
    );
    assert.ok(staleLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
