/**
 * Tests for the odoo_quote_rpc scoped execute_kw bridge.
 *
 * Covers the frozen contract's acceptance criteria (spec AC-3):
 *   1. Every scope-table row is accepted by the scope check.
 *   2. A matrix of out-of-scope ops is refused with op_not_permitted — all in
 *      one response when batched, and NOTHING is sent to Odoo.
 *   3. Dry-run performs zero RPC writes (only the read-only search_read echo).
 *   4. Execute enforces plan_token / client_ref presence and token match.
 *   5. client_ref replay returns the stored result WITHOUT re-executing; a
 *      different ops-hash under the same client_ref conflicts.
 *   6. Batch stop-on-first-error reports per-op executed/failed/not_run.
 *   7. bot_session_id is present in every RPC context (incl. the dry-run echo).
 *   8. Schema: additionalProperties:false rejection; empty ops rejected.
 *
 * No network: the execute path is exercised through an injected stub client,
 * and the context-merge is proved through a real OdooClient with a stubbed
 * XML-RPC transport.
 *
 * Run: npx tsx --test tests/quote-rpc.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";

import {
  createOdooQuoteRpcTool,
  isOpPermitted,
  computePlanToken,
  QUOTE_RPC_SCOPE,
  type QuoteRpcClient,
} from "../src/tools.js";
import { OdooClient } from "../src/client.js";

function buildConfig() {
  return {
    channels: {
      odoo: {
        url: "https://odoo.example.invalid",
        db: "test",
        uid: 1,
        password: "secret",
        webhookSecret: "webhook-secret",
        webhookPath: "/odoo/chatter",
        botSessionId: "sess-123",
        routes: [
          {
            match: "*",
            reply: { method: "message_post", args: ["body", "requestMessageId"] },
          },
        ],
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cfg = buildConfig() as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, any>;

function makeStub(opts?: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callMethod?: (params: AnyRec) => any;
  searchRead?: (params: AnyRec) => AnyRec[];
}) {
  const calls = { callMethod: [] as AnyRec[], searchRead: [] as AnyRec[] };
  const client: QuoteRpcClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async callMethod(params: AnyRec): Promise<any> {
      calls.callMethod.push(params);
      return opts?.callMethod ? opts.callMethod(params) : true;
    },
    async searchRead(params: AnyRec): Promise<AnyRec[]> {
      calls.searchRead.push(params);
      return opts?.searchRead ? opts.searchRead(params) : [];
    },
  };
  return { calls, client };
}

// Invoke the tool and parse the JSON envelope back out of the text content.
async function run(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: { execute: (id: string, params: AnyRec) => Promise<any> },
  params: AnyRec,
): Promise<AnyRec> {
  const res = await tool.execute("call-1", params);
  return JSON.parse(res.content[0].text);
}

function newTool(clientOverride: QuoteRpcClient) {
  return createOdooQuoteRpcTool(cfg, clientOverride)();
}

// --------------------------------------------------------------------------
// AC-8: schema
// --------------------------------------------------------------------------

const schemaTool = newTool(makeStub().client);

test("schema: accepts a minimal valid ops batch", () => {
  const payload = {
    ops: [{ model: "sale.order", method: "write", args: [[1], { note: "x" }] }],
  };
  assert.ok(
    Value.Check(schemaTool.parameters, payload),
    () => JSON.stringify([...Value.Errors(schemaTool.parameters, payload)], null, 2),
  );
});

test("schema: accepts op kwargs passthrough (copy default / message_post body)", () => {
  const payload = {
    ops: [
      { model: "sale.order", method: "copy", args: [1], kwargs: { default: { name: "S-copy" } } },
      {
        model: "sale.order",
        method: "message_post",
        args: [[1]],
        kwargs: { body: "hi", subtype_xmlid: "mail.mt_note" },
      },
    ],
    dry_run: true,
  };
  assert.ok(
    Value.Check(schemaTool.parameters, payload),
    () => JSON.stringify([...Value.Errors(schemaTool.parameters, payload)], null, 2),
  );
});

test("schema: rejects empty ops (minItems 1)", () => {
  assert.equal(Value.Check(schemaTool.parameters, { ops: [] }), false);
});

test("schema: rejects an unknown top-level field (additionalProperties:false)", () => {
  const payload = {
    ops: [{ model: "sale.order", method: "write", args: [[1], {}] }],
    foo: 1,
  };
  assert.equal(Value.Check(schemaTool.parameters, payload), false);
});

test("schema: rejects an unknown op-level field (additionalProperties:false)", () => {
  const payload = {
    ops: [{ model: "sale.order", method: "write", args: [[1], {}], extra: 1 }],
  };
  assert.equal(Value.Check(schemaTool.parameters, payload), false);
});

test("schema: rejects a missing required op field (args)", () => {
  const payload = { ops: [{ model: "sale.order", method: "write" }] };
  assert.equal(Value.Check(schemaTool.parameters, payload), false);
});

// --------------------------------------------------------------------------
// AC-1 / hard rule / AC-2 (scope predicate)
// --------------------------------------------------------------------------

test("scope: every scope-table pair is permitted", () => {
  for (const [model, methods] of Object.entries(QUOTE_RPC_SCOPE)) {
    for (const method of methods) {
      assert.ok(
        isOpPermitted(model, method),
        `${model}.${method} should be permitted`,
      );
    }
  }
});

test("hard rule: product-data create/write/unlink/copy/etc. is never permitted", () => {
  const forbidden: Array<[string, string]> = [
    ["product.template", "write"],
    ["product.template", "create"],
    ["product.template", "copy"],
    ["product.template", "unlink"],
    ["product.product", "create"],
    ["product.product", "write"],
    ["product.product", "unlink"],
    ["product.product", "name_create"],
    ["product.product", "copy_data"],
    ["product.supplierinfo", "create"],
    ["product.supplierinfo", "write"],
    ["product.supplierinfo", "load"],
  ];
  for (const [model, method] of forbidden) {
    assert.equal(
      isOpPermitted(model, method),
      false,
      `${model}.${method} must be forbidden`,
    );
  }
});

test("scope: product.template/product.product allow message_post only", () => {
  assert.equal(isOpPermitted("product.template", "message_post"), true);
  assert.equal(isOpPermitted("product.product", "message_post"), true);
  assert.equal(isOpPermitted("product.template", "write"), false);
});

test("scope: other out-of-scope pairs are refused", () => {
  assert.equal(isOpPermitted("sale.order", "unlink"), false);
  assert.equal(isOpPermitted("res.partner", "create"), false);
  assert.equal(isOpPermitted("sale.order.line", "create"), false);
});

// --------------------------------------------------------------------------
// AC-2: batched out-of-scope refusal — all at once, nothing sent to Odoo
// --------------------------------------------------------------------------

test("dry-run: batched out-of-scope ops all refused; nothing sent to Odoo", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [
    { model: "product.template", method: "write", args: [[1], {}] },
    { model: "product.supplierinfo", method: "create", args: [{}] },
    { model: "sale.order", method: "unlink", args: [[5]] },
    { model: "product.template", method: "create", args: [{}] },
    { model: "product.product", method: "unlink", args: [[2]] },
    { model: "product.template", method: "copy", args: [3] },
    { model: "product.product", method: "name_create", args: ["x"] },
    { model: "product.supplierinfo", method: "load", args: [[], []] },
    { model: "res.partner", method: "create", args: [{}] },
  ];
  const env = await run(tool, { ops, dry_run: true });

  assert.equal(env.ok, false);
  assert.equal(env.errors.length, ops.length, "one error per violating op");
  for (let i = 0; i < ops.length; i++) {
    assert.equal(env.errors[i].code, "op_not_permitted");
    assert.match(env.errors[i].message, new RegExp(`op\\[${i}\\]`));
    assert.ok(typeof env.errors[i].hint === "string" && env.errors[i].hint.length > 0);
  }
  // nothing sent to Odoo — neither a write nor the read-only echo
  assert.equal(stub.calls.callMethod.length, 0);
  assert.equal(stub.calls.searchRead.length, 0);
});

test("dry-run: product-model refusal carries the product-data hint", async () => {
  const tool = newTool(makeStub().client);
  const env = await run(tool, {
    ops: [{ model: "product.template", method: "write", args: [[1], {}] }],
    dry_run: true,
  });
  assert.equal(env.ok, false);
  assert.match(env.errors[0].hint, /odoo_spawn_customer_product/);
  assert.match(env.errors[0].hint, /odoo_create_custom_product/);
});

// --------------------------------------------------------------------------
// AC-3: dry-run zero writes + target echo
// --------------------------------------------------------------------------

test("dry-run: valid batch yields plan + token with zero writes and echo only for write/unlink/copy", async () => {
  const stub = makeStub({
    searchRead: () => [{ id: 456, display_name: "S376204", state: "draft" }],
  });
  const tool = newTool(stub.client);
  const ops = [
    { model: "sale.order", method: "write", args: [[456], { note: "hi" }] },
    { model: "sale.order.line", method: "unlink", args: [[10, 11]] },
    { model: "sale.order", method: "create", args: [{ partner_id: 1 }] },
    { model: "sale.order", method: "message_post", args: [[456]], kwargs: { body: "hello" } },
  ];
  const env = await run(tool, { ops, dry_run: true });

  assert.equal(env.ok, true);
  assert.equal(env.dry_run, true);
  assert.ok(typeof env.plan_token === "string" && env.plan_token.startsWith("sha256:"));

  // zero writes; echo only for the 2 write/unlink/copy ops
  assert.equal(stub.calls.callMethod.length, 0);
  assert.equal(stub.calls.searchRead.length, 2);

  // write on sale.order -> targets include state
  assert.equal(env.plan[0].method, "write");
  assert.ok(Array.isArray(env.plan[0].targets));
  assert.equal(env.plan[0].targets[0].state, "draft");

  // unlink on sale.order.line -> targets WITHOUT state
  assert.equal(env.plan[1].method, "unlink");
  assert.ok(Array.isArray(env.plan[1].targets));
  assert.equal(env.plan[1].targets[0].state, undefined);

  // create / message_post -> no targets key
  assert.equal(env.plan[2].targets, undefined);
  assert.equal(env.plan[3].targets, undefined);

  // token is stable and matches the standalone helper
  assert.equal(env.plan_token, computePlanToken(ops));
});

test("dry-run: unparseable target ids yield empty targets and a note in the summary", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [{ model: "sale.order", method: "write", args: ["not-an-id", {}] }];
  const env = await run(tool, { ops, dry_run: true });

  assert.equal(env.ok, true);
  assert.deepEqual(env.plan[0].targets, []);
  assert.match(env.plan[0].summary, /unparseable/);
  // no ids resolved -> no search_read issued
  assert.equal(stub.calls.searchRead.length, 0);
});

// --------------------------------------------------------------------------
// AC-4: token / client_ref gating on execute
// --------------------------------------------------------------------------

test("execute: without plan_token -> plan_token_required, nothing executed", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [{ model: "sale.order", method: "write", args: [[1], {}] }];
  const env = await run(tool, { ops, client_ref: "c1" });
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, "plan_token_required");
  assert.equal(stub.calls.callMethod.length, 0);
});

test("execute: with a stale/wrong plan_token -> plan_token_mismatch, nothing executed", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [{ model: "sale.order", method: "write", args: [[1], {}] }];
  const env = await run(tool, { ops, plan_token: "sha256:deadbeef", client_ref: "c1" });
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, "plan_token_mismatch");
  assert.equal(stub.calls.callMethod.length, 0);
});

test("execute: without client_ref -> client_ref_required, nothing executed", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [{ model: "sale.order", method: "write", args: [[1], {}] }];
  const env = await run(tool, { ops, plan_token: computePlanToken(ops) });
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, "client_ref_required");
  assert.equal(stub.calls.callMethod.length, 0);
});

test("execute: out-of-scope op refused even with a valid token (defense in depth)", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [{ model: "product.template", method: "write", args: [[1], { name: "x" }] }];
  const env = await run(tool, {
    ops,
    plan_token: computePlanToken(ops), // caller-computed, structurally valid
    client_ref: "cref-dd",
  });
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, "op_not_permitted");
  assert.equal(stub.calls.callMethod.length, 0);
});

// --------------------------------------------------------------------------
// AC-5: idempotency
// --------------------------------------------------------------------------

test("execute: replay with same client_ref + same ops returns stored result without re-executing", async () => {
  let n = 0;
  const stub = makeStub({
    callMethod: () => {
      n += 1;
      return n;
    },
  });
  const tool = newTool(stub.client);
  const ops = [{ model: "sale.order", method: "write", args: [[1], { note: "x" }] }];
  const token = computePlanToken(ops);

  const first = await run(tool, { ops, plan_token: token, client_ref: "cref-1" });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent_replay, undefined);
  assert.equal(stub.calls.callMethod.length, 1);

  const second = await run(tool, { ops, plan_token: token, client_ref: "cref-1" });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent_replay, true);
  assert.equal(stub.calls.callMethod.length, 1, "replay must NOT re-execute");
  assert.deepEqual(second.results, first.results);
});

test("execute: same client_ref + different ops -> client_ref_conflict, not executed", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const opsA = [{ model: "sale.order", method: "write", args: [[1], { note: "a" }] }];
  const opsB = [{ model: "sale.order", method: "write", args: [[1], { note: "b" }] }];

  const a = await run(tool, { ops: opsA, plan_token: computePlanToken(opsA), client_ref: "cref-x" });
  assert.equal(a.ok, true);
  assert.equal(stub.calls.callMethod.length, 1);

  const b = await run(tool, { ops: opsB, plan_token: computePlanToken(opsB), client_ref: "cref-x" });
  assert.equal(b.ok, false);
  assert.equal(b.errors[0].code, "client_ref_conflict");
  assert.equal(stub.calls.callMethod.length, 1, "conflict must NOT execute");
});

// --------------------------------------------------------------------------
// AC-6: batch stop-on-first-error
// --------------------------------------------------------------------------

test("execute: stops on the first error and reports executed/failed/not_run", async () => {
  const stub = makeStub({
    callMethod: (p) => {
      if (p.method === "unlink") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e: any = new Error("boom");
        e.faultString = "Odoo: cannot unlink";
        throw e;
      }
      return 1;
    },
  });
  const tool = newTool(stub.client);
  const ops = [
    { model: "sale.order", method: "write", args: [[1], { note: "x" }] },
    { model: "sale.order.line", method: "unlink", args: [[9]] },
    { model: "sale.order", method: "message_post", args: [[1]], kwargs: { body: "hi" } },
  ];
  const env = await run(tool, { ops, plan_token: computePlanToken(ops), client_ref: "cref-batch" });

  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, "execution_failed");
  assert.equal(env.errors[0].message, "Odoo: cannot unlink");

  assert.equal(env.results[0].status, "executed");
  assert.equal(env.results[0].result, 1);
  assert.equal(env.results[1].status, "failed");
  assert.equal(env.results[1].error, "Odoo: cannot unlink");
  assert.equal(env.results[2].status, "not_run");

  // op0 executed, op1 failed, op2 never attempted
  assert.equal(stub.calls.callMethod.length, 2);
});

test("execute: mid-batch failure is stored so a same-client_ref retry replays it", async () => {
  let attempts = 0;
  const stub = makeStub({
    callMethod: (p) => {
      attempts += 1;
      if (p.method === "unlink") throw new Error("db fault");
      return 1;
    },
  });
  const tool = newTool(stub.client);
  const ops = [
    { model: "sale.order", method: "write", args: [[1], {}] },
    { model: "sale.order.line", method: "unlink", args: [[9]] },
  ];
  const token = computePlanToken(ops);

  const first = await run(tool, { ops, plan_token: token, client_ref: "cref-mid" });
  assert.equal(first.ok, false);
  const attemptsAfterFirst = attempts;

  const replay = await run(tool, { ops, plan_token: token, client_ref: "cref-mid" });
  assert.equal(replay.ok, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(attempts, attemptsAfterFirst, "committed ops must not re-run on replay");
});

// --------------------------------------------------------------------------
// AC-7: bot_session_id in every RPC context
// --------------------------------------------------------------------------

test("bot_session_id is passed to every RPC (stub-level, dry-run + execute)", async () => {
  const stub = makeStub({
    searchRead: () => [{ id: 1, display_name: "S1", state: "draft" }],
  });
  const tool = newTool(stub.client);
  const ops = [{ model: "sale.order", method: "write", args: [[1], { note: "x" }] }];

  await run(tool, { ops, dry_run: true });
  await run(tool, { ops, plan_token: computePlanToken(ops), client_ref: "cref-bsid" });

  assert.ok(stub.calls.searchRead.length >= 1);
  assert.ok(stub.calls.callMethod.length >= 1);
  for (const c of stub.calls.searchRead) assert.equal(c.botSessionId, "sess-123");
  for (const c of stub.calls.callMethod) assert.equal(c.botSessionId, "sess-123");
});

test("bot_session_id lands in the execute_kw context (real client transport)", async () => {
  const realClient = new OdooClient({ url: "https://x.invalid", db: "d", uid: 7, password: "p" });
  const captured: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (realClient as any).objectClient = {
    methodCall: (_m: string, params: unknown[], cb: (e: unknown, r: unknown) => void) => {
      captured.push(params);
      cb(null, 999);
    },
  };
  const tool = createOdooQuoteRpcTool(cfg, realClient)();
  const ops = [{ model: "sale.order", method: "create", args: [{ partner_id: 1 }] }];
  const env = await run(tool, {
    ops,
    plan_token: computePlanToken(ops),
    client_ref: "cref-realclient-1",
  });

  assert.equal(env.ok, true);
  assert.equal(captured.length, 1);
  // execute_kw args: [db, uid, password, model, method, args, kwargs]
  const kwargs = captured[0][6] as AnyRec;
  assert.equal(kwargs.context.bot_session_id, "sess-123");
});

test("bot_session_id lands in the dry-run search_read context (real client transport)", async () => {
  const realClient = new OdooClient({ url: "https://x.invalid", db: "d", uid: 7, password: "p" });
  const captured: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (realClient as any).objectClient = {
    methodCall: (_m: string, params: unknown[], cb: (e: unknown, r: unknown) => void) => {
      captured.push(params);
      cb(null, [{ id: 1, display_name: "S1", state: "draft" }]);
    },
  };
  const tool = createOdooQuoteRpcTool(cfg, realClient)();
  const ops = [{ model: "sale.order", method: "write", args: [[1], { note: "x" }] }];
  const env = await run(tool, { ops, dry_run: true });

  assert.equal(env.ok, true);
  assert.equal(captured.length, 1, "dry-run issues only the read-only echo");
  assert.equal(captured[0][4], "search_read");
  const kwargs = captured[0][6] as AnyRec;
  assert.equal(kwargs.context.bot_session_id, "sess-123");
});

// --------------------------------------------------------------------------
// x2many command-cascade guard (product-write bypass)
// --------------------------------------------------------------------------

const SO = 500;

test("cascade guard: PRIMARY bypass (product_to_archive_ids create + nested seller_ids) rejected; nothing sent", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [
    {
      model: "sale.order",
      method: "write",
      args: [
        [SO],
        {
          product_to_archive_ids: [
            [0, 0, { name: "X", seller_ids: [[0, 0, { name: 8412 }]] }],
          ],
        },
      ],
    },
  ];
  const env = await run(tool, { ops, dry_run: true });
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e: AnyRec) => e.code === "unsafe_relational_write"));
  assert.equal(stub.calls.callMethod.length, 0);
  assert.equal(stub.calls.searchRead.length, 0);
});

test("cascade guard: sale.order.create order_line nesting a seller_ids create is rejected", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [
    {
      model: "sale.order",
      method: "create",
      args: [
        {
          partner_id: 1,
          order_line: [
            [0, 0, { product_id: 9, product_uom_qty: 1, seller_ids: [[0, 0, { name: 8412 }]] }],
          ],
        },
      ],
    },
  ];
  const env = await run(tool, { ops, dry_run: true });
  assert.equal(env.ok, false);
  const v = env.errors.find((e: AnyRec) => e.code === "unsafe_relational_write");
  assert.ok(v, "expected an unsafe_relational_write violation");
  assert.match(v.message, /seller_ids/);
  assert.equal(stub.calls.callMethod.length, 0);
});

const rejectedCascadeCases: Array<{ name: string; op: AnyRec }> = [
  {
    name: "product_to_archive_ids update [[1,id,{}]]",
    op: { model: "sale.order", method: "write", args: [[SO], { product_to_archive_ids: [[1, 77, { name: "y" }]] }] },
  },
  {
    name: "product_to_archive_ids delete [[2,id]]",
    op: { model: "sale.order", method: "write", args: [[SO], { product_to_archive_ids: [[2, 77]] }] },
  },
  {
    name: "pack_ids update [[1,id,{}]]",
    op: { model: "sale.order", method: "write", args: [[SO], { pack_ids: [[1, 88, { name: "z" }]] }] },
  },
  {
    name: "tag_ids create [[0,0,{}]] (code 0 not under order_line)",
    op: { model: "sale.order", method: "write", args: [[SO], { tag_ids: [[0, 0, { name: "t" }]] }] },
  },
  {
    name: "order_line create on WRITE (only create is excepted)",
    op: { model: "sale.order", method: "write", args: [[SO], { order_line: [[0, 0, { product_id: 9 }]] }] },
  },
  {
    name: "command 5 (delete-all-relations)",
    op: { model: "sale.order", method: "write", args: [[SO], { order_line: [[5, 0, 0]] }] },
  },
  {
    name: "create with product_to_archive_ids create",
    op: { model: "sale.order", method: "create", args: [{ partner_id: 1, product_to_archive_ids: [[0, 0, { name: "P" }]] }] },
  },
  {
    name: "copy default with product_to_archive_ids create",
    op: { model: "sale.order", method: "copy", args: [SO], kwargs: { default: { product_to_archive_ids: [[0, 0, { name: "P" }]] } } },
  },
  {
    name: "message_post with attachment_ids create",
    op: { model: "sale.order", method: "message_post", args: [[SO]], kwargs: { body: "hi", attachment_ids: [[0, 0, { name: "a" }]] } },
  },
  {
    name: "unrecognized array field value (malformed -> safe-default reject)",
    op: { model: "sale.order", method: "write", args: [[SO], { some_field: [[0, 0, {}], "junk"] }] },
  },
];

for (const c of rejectedCascadeCases) {
  test(`cascade guard: rejected — ${c.name}; nothing sent`, async () => {
    const stub = makeStub();
    const tool = newTool(stub.client);
    const env = await run(tool, { ops: [c.op], dry_run: true });
    assert.equal(env.ok, false, JSON.stringify(env));
    assert.ok(
      env.errors.some((e: AnyRec) => e.code === "unsafe_relational_write"),
      JSON.stringify(env.errors),
    );
    assert.equal(stub.calls.callMethod.length, 0);
    assert.equal(stub.calls.searchRead.length, 0);
  });
}

const acceptedCascadeCases: Array<{ name: string; op: AnyRec }> = [
  {
    name: "sale.order.create order_line with tax_id replace (code 6)",
    op: {
      model: "sale.order",
      method: "create",
      args: [
        {
          partner_id: 1,
          order_line: [
            [0, 0, { product_id: 9, product_uom_qty: 1, price_unit: 2, name: "L", tax_id: [[6, 0, [3]]] }],
          ],
        },
      ],
    },
  },
  {
    name: "print.design.create with print_color_ids/madeira_color_ids replace (code 6)",
    op: { model: "print.design", method: "create", args: [{ name: "D", print_color_ids: [[6, 0, [1, 2]]], madeira_color_ids: [[6, 0, [5]]] }] },
  },
  {
    name: "sale.order.write tag_ids link (code 4)",
    op: { model: "sale.order", method: "write", args: [[SO], { tag_ids: [[4, 12]] }] },
  },
  {
    name: "sale.order.write tag_ids replace (code 6)",
    op: { model: "sale.order", method: "write", args: [[SO], { tag_ids: [[6, 0, [12, 13]]] }] },
  },
  {
    name: "sale.order.write scalar vals only",
    op: { model: "sale.order", method: "write", args: [[SO], { note: "hello" }] },
  },
  {
    name: "sale.order.write with an empty x2many list (no commands)",
    op: { model: "sale.order", method: "write", args: [[SO], { order_line: [] }] },
  },
  {
    name: "sale.order.line.write scalar qty",
    op: { model: "sale.order.line", method: "write", args: [[42], { product_uom_qty: 3 }] },
  },
];

for (const c of acceptedCascadeCases) {
  test(`cascade guard: accepted — ${c.name}`, async () => {
    const stub = makeStub();
    const tool = newTool(stub.client);
    const env = await run(tool, { ops: [c.op], dry_run: true });
    assert.equal(env.ok, true, JSON.stringify(env));
    assert.ok(typeof env.plan_token === "string" && env.plan_token.startsWith("sha256:"));
  });
}

test("cascade guard: rejected on the execute path with a valid self-computed token; nothing sent", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [
    { model: "sale.order", method: "write", args: [[SO], { product_to_archive_ids: [[0, 0, { name: "X" }]] }] },
  ];
  const env = await run(tool, {
    ops,
    plan_token: computePlanToken(ops),
    client_ref: "cref-cascade-dd",
  });
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e: AnyRec) => e.code === "unsafe_relational_write"));
  assert.equal(stub.calls.callMethod.length, 0);
});

test("cascade guard: batched scope + cascade violations reported together; nothing sent", async () => {
  const stub = makeStub();
  const tool = newTool(stub.client);
  const ops = [
    { model: "product.template", method: "write", args: [[1], { name: "x" }] }, // op_not_permitted
    { model: "sale.order", method: "write", args: [[SO], { pack_ids: [[1, 2, {}]] }] }, // unsafe
    { model: "sale.order", method: "write", args: [[SO], { note: "ok" }] }, // clean
  ];
  const env = await run(tool, { ops, dry_run: true });
  assert.equal(env.ok, false);
  const codes = env.errors.map((e: AnyRec) => e.code);
  assert.ok(codes.includes("op_not_permitted"));
  assert.ok(codes.includes("unsafe_relational_write"));
  assert.equal(stub.calls.callMethod.length, 0);
  assert.equal(stub.calls.searchRead.length, 0);
});

// --------------------------------------------------------------------------
// plan_token canonicalization
// --------------------------------------------------------------------------

test("computePlanToken: canonical JSON sorts object keys and keeps array order", () => {
  const ops = [{ model: "sale.order", method: "write", args: [[1], { b: 2, a: 1 }] }];
  const canonical = '[{"args":[[1],{"a":1,"b":2}],"method":"write","model":"sale.order"}]';
  const expected = "sha256:" + createHash("sha256").update(canonical).digest("hex");
  assert.equal(computePlanToken(ops), expected);
});

test("computePlanToken: stable regardless of op key order", () => {
  const a = computePlanToken([{ model: "sale.order", method: "write", args: [[1], {}] }]);
  const b = computePlanToken([{ method: "write", args: [[1], {}], model: "sale.order" }]);
  assert.equal(a, b);
});

test("tool identity: name and label are stable", () => {
  const tool = newTool(makeStub().client);
  assert.equal(tool.name, "odoo_quote_rpc");
  assert.equal(tool.label, "Odoo Quote RPC (scoped bridge)");
});
