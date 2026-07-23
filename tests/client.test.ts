/**
 * Tests for src/client.ts — the per-RPC timeout on OdooClient.executeKw.
 *
 * executeKw wraps the XML-RPC methodCall with a timeout so a hung Odoo call
 * rejects with RpcTimeoutError after rpcTimeoutMs instead of stalling the whole
 * operation until the far larger channel-level dispatch timeout. These tests
 * drive executeKw through the public callMethod, injecting a fake transport
 * (objectClient) so no network is used.
 *
 * Run: npx tsx --test tests/client.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  OdooClient,
  RpcTimeoutError,
  DEFAULT_RPC_TIMEOUT_MS,
} from "../src/client.js";

function makeClient(rpcTimeoutMs?: number) {
  return new OdooClient({
    url: "https://x.invalid",
    db: "d",
    uid: 7,
    password: "p",
    ...(rpcTimeoutMs !== undefined ? { rpcTimeoutMs } : {}),
  });
}

// Replace the XML-RPC transport with a fake. `impl` gets (method, params, cb).
function stubTransport(
  client: OdooClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  impl: (method: string, params: unknown[], cb: (e: any, r: any) => void) => void,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).objectClient = { methodCall: impl };
}

test("executeKw rejects with RpcTimeoutError when the transport never settles", async () => {
  const client = makeClient(15);
  stubTransport(client, () => {
    /* never calls back */
  });
  await assert.rejects(
    client.callMethod({ model: "sale.order", method: "write", args: [[1], {}] }),
    (err: unknown) =>
      err instanceof RpcTimeoutError &&
      err.code === "rpc_timeout" &&
      err.model === "sale.order" &&
      err.method === "write" &&
      err.timeoutMs === 15,
  );
});

test("RpcTimeoutError message names the model/method and the timeout", () => {
  const err = new RpcTimeoutError("sale.order", "create", 120_000);
  assert.match(err.message, /sale\.order\.create/);
  assert.match(err.message, /120000ms/);
  assert.equal(err.name, "RpcTimeoutError");
  assert.equal(err.code, "rpc_timeout");
});

test("a callback that fires before the timeout resolves normally (timer cleared)", async () => {
  const client = makeClient(10_000);
  stubTransport(client, (_m, _p, cb) => cb(null, 42));
  const result = await client.callMethod({
    model: "sale.order",
    method: "write",
    args: [[1], {}],
  });
  assert.equal(result, 42);
});

test("a transport error before the timeout rejects with that error (not a timeout)", async () => {
  const client = makeClient(10_000);
  const fault = new Error("xmlrpc fault");
  stubTransport(client, (_m, _p, cb) => cb(fault, null));
  await assert.rejects(
    client.callMethod({ model: "sale.order", method: "write", args: [[1], {}] }),
    (err: unknown) => err === fault,
  );
});

test("a late callback arriving after the timeout is ignored (single-settle)", async () => {
  const client = makeClient(10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let savedCb: ((e: any, r: any) => void) | undefined;
  stubTransport(client, (_m, _p, cb) => {
    savedCb = cb;
  });
  await assert.rejects(
    client.callMethod({ model: "sale.order", method: "write", args: [[1], {}] }),
    (err: unknown) => err instanceof RpcTimeoutError,
  );
  // The transport's late callback must be a harmless no-op — the promise has
  // already settled with the timeout, so this must not double-settle or throw.
  assert.doesNotThrow(() => savedCb?.(null, 999));
});

test("DEFAULT_RPC_TIMEOUT_MS is 120000 (120s)", () => {
  assert.equal(DEFAULT_RPC_TIMEOUT_MS, 120_000);
});
