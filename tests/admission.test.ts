import test from "node:test";
import assert from "node:assert/strict";
import { createDispatchAdmissionController } from "../src/inbox/admission.js";
import type { InboxBatch } from "../src/inbox/types.js";

function batch(batchKey = "abc"): InboxBatch {
  return {
    batchKey,
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
  };
}

test("admission controller limits concurrent dispatches and releases tickets", () => {
  const controller = createDispatchAdmissionController({
    maxConcurrentDispatches: 1,
    retryDelayMs: 15_000,
    minDispatchSpacingMs: 0,
    maxProcessRssMb: 0,
    maxEventLoopDelayMs: 0,
  });

  const first = controller.tryAcquire(batch("one"));
  assert.equal(first.ok, true);

  const second = controller.tryAcquire(batch("two"));
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "concurrency_1_ge_1");
    assert.equal(second.retryMs, 15_000);
  }

  if (first.ok) first.ticket.release();
  assert.equal(controller.tryAcquire(batch("three")).ok, true);
});

test("admission controller enforces minimum spacing between dispatch starts", () => {
  let now = 10_000;
  const controller = createDispatchAdmissionController({
    maxConcurrentDispatches: 2,
    retryDelayMs: 15_000,
    minDispatchSpacingMs: 5_000,
    maxProcessRssMb: 0,
    maxEventLoopDelayMs: 0,
    now: () => now,
  });

  const first = controller.tryAcquire(batch("one"));
  assert.equal(first.ok, true);
  if (first.ok) first.ticket.release();

  now = 12_000;
  const second = controller.tryAcquire(batch("two"));
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "spacing_3000ms");
    assert.equal(second.retryMs, 15_000);
  }

  now = 15_000;
  assert.equal(controller.tryAcquire(batch("three")).ok, true);
});
