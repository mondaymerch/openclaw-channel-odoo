/**
 * Agent tools backed by the Odoo XML-RPC transport.
 *
 *  - odoo_search_read            — standard `search_read` on any model.
 *  - odoo_spawn_customer_product — spawn a platform-bound customer product
 *                                  from a catalogue parent (agent.api).
 *  - odoo_create_custom_product  — create an out-of-catalogue custom product
 *                                  from a purchasing spec (agent.api).
 *
 * The two product-creation tools are thin transport: all business logic
 * (validation, dedup, dry-run plan-validation, idempotency, VAT/price
 * correctness) lives in the `agent.api` Odoo model. These tools forward the
 * payload as the
 * single positional argument and return the response envelope VERBATIM —
 * they never transform it and never swallow an `ok:false` failure, because the
 * structured error envelope is designed for the agent itself to read and act
 * on (each error carries a `hint`).
 *
 * TypeBox schema vs server validation — deliberate split:
 *   The schemas enforce STRUCTURE only — field names, JSON types, which fields
 *   are required, enum membership, and `additionalProperties: false` (so the
 *   fields the agent must never pass — partner, company_id, currency_id,
 *   list_price, categ_id, hs_code, product_size_category, mm_responsible_id,
 *   mm_design_status_id, mm_partner_id, print_design_ids, set_internal_review —
 *   are rejected client-side simply by not existing here). VALUE semantics
 *   (positivity, ranges, id existence, vendor ambiguity, dedup, draft/platform
 *   checks) are intentionally NOT duplicated in the schema: the Odoo method
 *   collects every such problem and returns them all in one structured
 *   response, and duplicating range checks here would fragment that
 *   "all errors at once" guarantee and create a second source of truth.
 */

import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { OdooClient, RpcTimeoutError } from "./client.js";
import { resolveAccount } from "./channel.js";

// Reuse cached clients
const toolClients = new Map<string, OdooClient>();

function getToolClient(cfg: OpenClawConfig): OdooClient {
  const account = resolveAccount(cfg);
  const key = `${account.url}:${account.db}:${account.uid}`;
  let client = toolClients.get(key);
  if (!client) {
    client = new OdooClient({
      url: account.url,
      db: account.db,
      uid: account.uid,
      password: account.password,
      rpcTimeoutMs: account.rpcTimeoutMs,
    });
    toolClients.set(key, client);
  }
  return client;
}

export function createOdooSearchReadTool(cfg: OpenClawConfig) {
  // Validate config at registration time
  const registeredAccount = resolveAccount(cfg);
  const botSessionId = registeredAccount.botSessionId;

  return () => ({
    name: "odoo_search_read",
    label: "Odoo Search & Read",
    description:
      "Search and read records from Odoo via XML-RPC. " +
      "Use this to fetch conversation history (model: openclaw.message), " +
      "record details, linked contacts, or any Odoo data. " +
      "The domain parameter uses Odoo's domain syntax: " +
      'e.g. [["model","=","crm.lead"],["res_id","=",1234]]',
    parameters: Type.Object(
      {
        model: Type.String({
          description:
            'Odoo model name, e.g. "crm.lead", "sale.order", "openclaw.message"',
        }),
        domain: Type.Array(Type.Unknown(), {
          description:
            'Odoo domain filter as a list of tuples, e.g. [["stage_id","=",1]]',
        }),
        fields: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Fields to return, e.g. ["name","stage_id","partner_id"]. Empty = all fields.',
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 200,
            description: "Max records to return (default: 20, max: 200)",
          }),
        ),
        order: Type.Optional(
          Type.String({
            description: 'Sort order, e.g. "id desc", "create_date asc"',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (
      _toolCallId: string,
      params: {
        model: string;
        domain: unknown[];
        fields?: string[];
        limit?: number;
        order?: string;
      },
    ) => {
      const client = getToolClient(cfg);
      const records = await client.searchRead({
        model: params.model,
        domain: params.domain,
        fields: params.fields,
        limit: params.limit,
        order: params.order,
        botSessionId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(records, null, 2),
          },
        ],
        details: undefined,
      };
    },
  });
}

// Shared field fragments (declared once so both product tools document the
// two-step plan-validation flow and idempotency identically).

const dryRunField = Type.Optional(
  Type.Boolean({
    description:
      "Two-step plan-validation flow. Call FIRST with dry_run:true — the tool " +
      "validates every op, reports all problems at once, and returns the " +
      "normalized `plan` plus a `plan_token`, with ZERO writes. The plan_token " +
      "is a deterministic sha256 of the canonical ops — a consistency check " +
      "binding args only, NOT a record of human review and NOT an " +
      "authorization boundary. Review the returned plan against the request, " +
      "then call again with dry_run:false, the SAME payload, plus that " +
      "plan_token to execute — guaranteeing what executes is exactly what was " +
      "validated.",
  }),
);

const clientRefField = Type.Optional(
  Type.String({
    description:
      "Idempotency key. Required on execute (dry_run:false); recommended " +
      "always. A repeated execute with the same client_ref and an identical " +
      "payload returns the stored original result with idempotent_replay:true " +
      "(nothing is created twice); the same client_ref with a different payload " +
      "returns client_ref_conflict. dry_run calls neither consume nor record it.",
  }),
);

const planTokenField = Type.Optional(
  Type.String({
    description:
      "The sha256 plan_token returned by the matching dry_run call. Required on " +
      "execute. It is a consistency hash of the ops' args (NOT a record of " +
      "human review and NOT an authorization boundary); a matching token " +
      "guarantees what executes is exactly what was validated in the dry_run. A " +
      "wrong/absent token returns plan_token_mismatch/plan_token_required.",
  }),
);

// `{id}` or `{name}` selector object. Both keys are optional at the schema
// level and additionalProperties:false; the server requires exactly one and
// returns a structured error (e.g. so_not_found) otherwise — keeping the
// helpful hint on the server side rather than as a schema error. Kept generic
// across both tools; per-tool server-side derivations (partner for spawn,
// company/currency for custom) are documented on each tool, not here.
const targetSoField = Type.Optional(
  Type.Object(
    {
      id: Type.Optional(
        Type.Integer({ description: "sale.order id." }),
      ),
      name: Type.Optional(
        Type.String({ description: 'sale.order name, e.g. "S376204".' }),
      ),
    },
    {
      additionalProperties: false,
      description:
        "Optional. When set, a sale.order.line is appended after creation. " +
        "Identify the order by EXACTLY ONE of `id` or `name`. The SO must be in " +
        "draft state and its platform must match platform_id (else so_not_draft " +
        "/ so_platform_mismatch).",
    },
  ),
);

export function createOdooSpawnCustomerProductTool(cfg: OpenClawConfig) {
  const registeredAccount = resolveAccount(cfg);
  const botSessionId = registeredAccount.botSessionId;

  return () => ({
    name: "odoo_spawn_customer_product",
    label: "Odoo Spawn Customer Product",
    description:
      "Spawn a platform-bound CUSTOMER product (a child of a catalogue parent " +
      "template) for one customer, via the transactional agent.api service. " +
      "The tool enforces reuse-first dedup, validity gates and the two-step " +
      "dry-run plan-validation flow server-side and returns a structured " +
      "response envelope (never a raw traceback). ALWAYS call with dry_run:true " +
      "first, review the returned plan against the request, then execute with " +
      "the plan_token (a consistency hash of the args, not evidence of human " +
      "review). When target_so is set, the appended line's partner is always " +
      "derived " +
      "from that SO server-side — never attempt to pass a partner. For an " +
      "out-of-catalogue product with no parent, use odoo_create_custom_product " +
      "instead.",
    parameters: Type.Object(
      {
        parent_variant_id: Type.Integer({
          description:
            "Required. product.product id of the parent VARIANT (the " +
            "colour-level variant) to spawn from. Its template must have " +
            "mm_is_parent_template = True (else parent_not_parent_template).",
        }),
        platform_id: Type.Integer({
          description:
            "Required. platforms record id — the customer platform the spawned " +
            "customer product is bound to.",
        }),
        print_configuration_ids: Type.Array(Type.Integer(), {
          description:
            "Required (may be []). Ids of active print.configuration records, " +
            "each of which must belong to the parent template's " +
            "print_configuration_ids (else print_config_invalid lists the bad " +
            "ids). An empty list makes the factory fall back to the parent's " +
            "preferred configurations, returning a preferred_configs_used " +
            "warning naming which were applied.",
        }),
        custom_name: Type.Optional(
          Type.String({
            description:
              "Optional. Overrides the spawned child's name; falls back to the " +
              "parent variant name when omitted. Unicode/emoji are accepted.",
          }),
        ),
        target_so: targetSoField,
        quantity: Type.Optional(
          Type.Integer({
            description:
              "Required when target_so is set (ignored otherwise). Quantity for " +
              "the appended order line, in whole units — merch quantities are " +
              "never fractional (the underlying Odoo product_uom_qty is a Float, " +
              "but this tool is deliberately stricter). The server validates it " +
              "is > 0.",
          }),
        ),
        client_ref: clientRefField,
        dry_run: dryRunField,
        plan_token: planTokenField,
      },
      { additionalProperties: false },
    ),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ) => {
      const client = getToolClient(cfg);
      const envelope = await client.callMethod({
        model: "agent.api",
        method: "spawn_customer_product",
        args: [params],
        botSessionId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(envelope, null, 2),
          },
        ],
        details: undefined,
      };
    },
  });
}

export function createOdooCreateCustomProductTool(cfg: OpenClawConfig) {
  const registeredAccount = resolveAccount(cfg);
  const botSessionId = registeredAccount.botSessionId;

  return () => ({
    name: "odoo_create_custom_product",
    label: "Odoo Create Custom Product",
    description:
      "Create an out-of-catalogue CUSTOM product (no parent template) from a " +
      "purchasing spec, via the transactional agent.api service. The tool " +
      "creates the product.template + product.supplierinfo, derives the sale " +
      "price from cost × sales_factor, resolves company/currency/vendor " +
      "server-side, and enforces the two-step dry-run plan-validation flow. It " +
      "returns a structured response envelope (never a raw traceback). ALWAYS " +
      "call with dry_run:true first, review the plan (including its warnings) " +
      "against the request, then execute with the plan_token (a consistency " +
      "hash of the args, not evidence of human review). To spawn a catalogue " +
      "child instead, use odoo_spawn_customer_product.",
    parameters: Type.Object(
      {
        name: Type.String({
          description:
            "Required. The full composed product name (also used as " +
            'description_sale), e.g. "Organic Cotton T-Shirt (Red) Digital ' +
            'Transfer – Front & Back + Neck Print". Compose it from the spec; ' +
            "Unicode/emoji are accepted.",
        }),
        platform_id: Type.Integer({
          description:
            "Required. platforms record id the custom product is bound to.",
        }),
        vendor: Type.Object(
          {
            id: Type.Optional(
              Type.Integer({ description: "res.partner id of the supplier." }),
            ),
            name: Type.Optional(
              Type.String({
                description:
                  "Supplier name, resolved server-side against ACTIVE supplier " +
                  "partners.",
              }),
            ),
          },
          {
            additionalProperties: false,
            description:
              "Required. The supplier partner. Provide EXACTLY ONE of `id` or " +
              "`name`. A name matching zero partners returns vendor_not_found; " +
              "multiple returns vendor_ambiguous with candidates — the tool " +
              "never fuzzy-picks. On vendor_ambiguous, re-call with vendor.id set " +
              "to one candidate, or escalate.",
          },
        ),
        vendor_url: Type.Optional(
          Type.String({
            description:
              "Optional vendor product-page URL. Absent → warning " +
              "vendor_url_missing. Rendered as an HTML link on the Sales tab and " +
              "as a plain URL on the Purchase tab.",
          }),
        ),
        vendor_sku: Type.Optional(
          Type.String({
            description:
              "Optional vendor SKU / article code; used as the link label when " +
              "vendor_url is present.",
          }),
        ),
        quantity: Type.Integer({
          description:
            "Required, must be > 0, in whole units — merch quantities are never " +
            "fractional (the underlying Odoo supplierinfo.min_qty is a Float, " +
            "but this tool is deliberately stricter). Becomes supplierinfo." +
            "min_qty, and the order-line quantity when target_so is set.",
        }),
        unit_cost: Type.Number({
          description:
            "Required, must be > 0. Vendor cost per unit → supplierinfo.price, " +
            "in the derived currency (see cost_currency). Never FX-converted.",
        }),
        cost_currency: Type.Optional(
          Type.String({
            description:
              "Optional ISO code of the currency your unit_cost is stated in. " +
              "This does NOT set the product currency — currency is derived " +
              "server-side (from the target SO, else the platform company). It is " +
              "used ONLY for a safety check: if it differs from the derived " +
              "currency the call hard-fails with currency_mismatch so the cost " +
              "can be restated. Do not use it to request a currency.",
          }),
        ),
        lead_time_days: Type.Integer({
          description:
            "Required, must be >= 0. Supplier delivery lead time → " +
            "supplierinfo.delay.",
        }),
        sales_factor: Type.Optional(
          Type.Number({
            description:
              "Optional markup multiplier → supplierinfo.mm_sales_factor; the " +
              "sale price is DERIVED as cost × sales_factor (never set " +
              "directly). Omitted → defaults to 2.1 with warning sf_defaulted. " +
              "Values outside [1.0, 5.0] but > 0 are accepted with warning " +
              "sf_out_of_band; <= 0 returns sf_invalid.",
          }),
        ),
        design_difficulty: Type.Union(
          [
            Type.Literal("easy"),
            Type.Literal("complex"),
            Type.Literal("standard"),
          ],
          {
            description:
              'Required. One of "easy", "complex", "standard". Use "complex" ' +
              "only for a genuinely custom design surface; a plain logo is " +
              '"easy"; when uncertain choose "easy".',
          },
        ),
        quick_reference_product_id: Type.Integer({
          description:
            "Required. Id of an ACTIVE template with mm_is_parent_template = " +
            "True, used as the dimensional/size reference. When dimensions/" +
            "weight are omitted, the tool copies dims, weight and " +
            "product_size_category from this record via the same onchange the " +
            "product form uses.",
        }),
        dimensions: Type.Optional(
          Type.Object(
            {
              length: Type.Optional(
                Type.Number({ description: "Length, > 0." }),
              ),
              width: Type.Optional(
                Type.Number({ description: "Width, > 0." }),
              ),
              height: Type.Optional(
                Type.Number({ description: "Height, > 0." }),
              ),
              unit: Type.Optional(
                Type.String({
                  description: "Unit of measure, e.g. cm / mm / in.",
                }),
              ),
            },
            {
              additionalProperties: false,
              description:
                "Optional, ALL-OR-NOTHING. Provide length, width, height and " +
                "unit together ONLY when traceable to a vendor page, the task " +
                "spec, or the requester — never estimate (the quick-reference " +
                "fallback covers estimation). All values must be > 0; a partial " +
                "set returns dims_incomplete. Requires dims_source when present.",
            },
          ),
        ),
        dims_source: Type.Optional(
          Type.Union(
            [
              Type.Literal("vendor_page"),
              Type.Literal("task_spec"),
              Type.Literal("requester_stated"),
            ],
            {
              description:
                "Required IF AND ONLY IF dimensions is present. One of " +
                '"vendor_page", "task_spec", "requester_stated" — records where ' +
                "the measurements came from.",
            },
          ),
        ),
        weight: Type.Optional(
          Type.Object(
            {
              value: Type.Optional(
                Type.Number({ description: "Weight value, > 0." }),
              ),
              unit: Type.Optional(
                Type.String({ description: "Weight unit, e.g. kg." }),
              ),
            },
            {
              additionalProperties: false,
              description:
                "Optional, independent of dimensions. Provide only when " +
                "traceable (same sourcing rule as dimensions).",
            },
          ),
        ),
        decorations: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional, AUDIT-ONLY in v1. Human-readable decoration lines " +
              '(e.g. "2x digital transfer (front+back)"). Recorded for the ' +
              "audit trail; no print.design records are created from them.",
          }),
        ),
        target_so: targetSoField,
        client_ref: clientRefField,
        dry_run: dryRunField,
        plan_token: planTokenField,
      },
      { additionalProperties: false },
    ),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ) => {
      const client = getToolClient(cfg);
      const envelope = await client.callMethod({
        model: "agent.api",
        method: "create_custom_product",
        args: [params],
        botSessionId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(envelope, null, 2),
          },
        ],
        details: undefined,
      };
    },
  });
}

// ===========================================================================
// odoo_quote_rpc — TEMPORARY scoped XML-RPC bridge for quote editing: a
// model/method-allowlisted execute_kw passthrough using gateway-held Odoo
// credentials.
//
// It runs execute_kw ONLY for the (model, method) pairs in QUOTE_RPC_SCOPE,
// enforced here in plugin code before any RPC leaves the process. Within those
// permitted models the agent constructs general execute_kw args — this is
// DATA-LEVEL access (which records/fields), not ACTION-level access (a fixed
// set of typed operations). Product data writes are impossible through it, both
// directly (product.template / product.product / product.supplierinfo
// create/write/unlink/copy are hard-forbidden) AND through nested x2many
// command cascades (see the cascade guard below); the two typed tools
// (odoo_spawn_customer_product / odoo_create_custom_product) remain the ONLY
// product-creation route.
//
// It is deliberately a bridge with planned expiry: each operation migrates to a
// dedicated deterministic tool (update_quote / configure_addons in wave 2,
// create_quote in wave 3) and this tool is removed once they ship.
//
// The plan_token binds the ops' ARGS ONLY — it is a consistency hash, NOT drift
// detection and NOT a human-authorization gate (see computePlanToken).
//
// The scope table is hardcoded on purpose — widening what the agent can write
// is always a reviewed plugin release, never a config or prompt change.
// ===========================================================================

/** Allowlist: model -> permitted methods. The ONLY pairs this bridge runs. */
export const QUOTE_RPC_SCOPE: Readonly<Record<string, readonly string[]>> = {
  "sale.order": [
    "create",
    "write",
    "copy",
    "message_post",
    "action_recalculate_handling_costs",
  ],
  "sale.order.line": ["write", "unlink"],
  "print.design": ["create", "write", "unlink"],
  "product.template": ["message_post"],
  "product.product": ["message_post"],
};

// Defense in depth. These pairs must NEVER pass, even if QUOTE_RPC_SCOPE is
// later edited incorrectly: no product-data create/write/unlink/copy/etc. is
// reachable through this bridge. print.design is the sole product-adjacent
// write, by decision; product.template/product.product get message_post only.
const HARD_FORBIDDEN_MODELS = new Set([
  "product.template",
  "product.product",
  "product.supplierinfo",
]);
const HARD_FORBIDDEN_METHODS = new Set([
  "create",
  "write",
  "unlink",
  "copy",
  "name_create",
  "copy_data",
  "load",
]);

/**
 * True iff (model, method) is allowed through the bridge. The hard-forbidden
 * gate runs FIRST so a mistaken scope-table edit can't open a product write —
 * this is the "hard rule" the refusal tests pin.
 */
export function isOpPermitted(model: string, method: string): boolean {
  if (HARD_FORBIDDEN_MODELS.has(model) && HARD_FORBIDDEN_METHODS.has(method)) {
    return false;
  }
  const methods = QUOTE_RPC_SCOPE[model];
  return methods !== undefined && methods.includes(method);
}

function opNotPermittedHint(model: string): string {
  if (HARD_FORBIDDEN_MODELS.has(model)) {
    return (
      "product data writes are not available to this agent; use " +
      "odoo_spawn_customer_product / odoo_create_custom_product, or hand off " +
      "to a human"
    );
  }
  return (
    "this (model, method) pair is outside the bridge scope; permitted: " +
    "sale.order {create, write, copy, message_post, " +
    "action_recalculate_handling_costs}, sale.order.line {write, unlink}, " +
    "print.design {create, write, unlink}, product.template/product.product " +
    "{message_post}; otherwise hand off to a human"
  );
}

// ---------------------------------------------------------------------------
// x2many command-cascade guard.
//
// The (model, method) allowlist is not enough: Odoo processes x2many command
// tuples inside `vals` by cascading create/write/unlink onto the COMODEL, which
// happens BELOW execute_kw where the allowlist can't see it. sale.order has
// x2many fields pointing at product.template (product_to_archive_ids M2M,
// pack_ids O2M), and a created/updated product.template can nest seller_ids
// (product.supplierinfo). So a permitted sale.order.write/create with
// `{"product_to_archive_ids": [[0,0,{...,"seller_ids":[[0,0,{}]]}]]}` would be
// full product CRUD — a bypass of the hard rule. We therefore inspect the vals
// here and reject any comodel-mutating command tuple.
//
// Command codes (Odoo ORM): 0 CREATE, 1 UPDATE, 2 DELETE, 3 UNLINK-relation,
// 4 LINK, 5 DELETE-ALL-relations, 6 REPLACE. {0,1,2,5} mutate/clear the comodel
// (5 can clear an O2M inverse); {3,4,6} only touch the relation table and are
// always allowed. The ONE allowed comodel-mutating command is (0,0,{...}) on
// `order_line` for sale.order.create — we recurse into that line's vals and
// apply the same rule, so a nested product/supplierinfo create is still caught.
const COMODEL_MUTATING_CODES = new Set([0, 1, 2, 5]);

// A single ORM command tuple: [code] | [code, id] | [code, id, values], where
// code is an integer 0..6. Values from JSON are arrays, never tuples.
function isCommandTuple(x: unknown): boolean {
  return (
    Array.isArray(x) &&
    x.length >= 1 &&
    x.length <= 3 &&
    typeof x[0] === "number" &&
    Number.isInteger(x[0]) &&
    (x[0] as number) >= 0 &&
    (x[0] as number) <= 6
  );
}

// Classify an array that appears as a FIELD VALUE inside a vals dict. The
// canonical x2many shape is a list of command tuples ([[0,0,{}],[4,5]]); a
// bare tuple ([0,0,{}]) is accepted defensively as a single command. Anything
// else non-empty is an unrecognized shape — treated as malformed and rejected
// (safe default), since no legitimate Odoo vals has a non-command array value.
function classifyFieldArray(
  value: unknown[],
):
  | { kind: "commands"; commands: unknown[][] }
  | { kind: "empty" }
  | { kind: "malformed" } {
  if (value.length === 0) return { kind: "empty" };
  if (value.every((el) => isCommandTuple(el))) {
    return { kind: "commands", commands: value as unknown[][] };
  }
  if (isCommandTuple(value)) {
    return { kind: "commands", commands: [value] };
  }
  return { kind: "malformed" };
}

interface QuoteRpcViolation {
  code: string;
  message: string;
  hint: string;
}

const UNSAFE_RELATIONAL_WRITE_HINT =
  "this tool cannot create/update/delete related records through x2many " +
  "command tuples (only order_line creation on sale.order.create is allowed); " +
  "product data must go through odoo_spawn_customer_product / " +
  "odoo_create_custom_product, or hand off to a human";

// Walk an op's args + kwargs, rejecting any comodel-mutating x2many command.
// All dicts reachable in args/kwargs are scanned (vals live at create args[0],
// write args[1], copy kwargs.default, message_post kwargs; scanning everything
// also catches vals hidden in nested command values or default_* context keys).
// Only dict FIELD VALUES are treated as command lists — the top-level ids arg
// (e.g. write args[0] = [id]) is a structural array, never a field value.
function scanForUnsafeCommands(
  op: QuoteRpcOp,
  opIndex: number,
  violations: QuoteRpcViolation[],
): void {
  const seen = new Set<unknown>();

  const flag = (field: string, detail: string): void => {
    violations.push({
      code: "unsafe_relational_write",
      message: `op[${opIndex}] ${op.model}.${op.method}: field "${field}" ${detail}`,
      hint: UNSAFE_RELATIONAL_WRITE_HINT,
    });
  };

  const scanDict = (dict: Record<string, unknown>): void => {
    if (seen.has(dict)) return;
    seen.add(dict);
    for (const [key, value] of Object.entries(dict)) {
      if (Array.isArray(value)) {
        const parsed = classifyFieldArray(value);
        if (parsed.kind === "empty") continue;
        if (parsed.kind === "malformed") {
          flag(
            key,
            "has an unrecognized array value (possible x2many command); rejected as a safety default",
          );
          continue;
        }
        for (const cmd of parsed.commands) {
          const code = cmd[0] as number;
          if (!COMODEL_MUTATING_CODES.has(code)) continue; // 3/4/6 relation-only
          const isOrderLineCreate =
            code === 0 &&
            key === "order_line" &&
            op.model === "sale.order" &&
            op.method === "create";
          if (isOrderLineCreate) {
            // Allowed line create — recurse into the line vals and re-apply the
            // rule so a nested seller_ids/product create inside a line is caught.
            const lineVals = cmd[2];
            if (
              lineVals !== null &&
              typeof lineVals === "object" &&
              !Array.isArray(lineVals)
            ) {
              scanDict(lineVals as Record<string, unknown>);
            }
            continue;
          }
          flag(
            key,
            `uses x2many command code ${code} (create/update/delete on the related model), which is not permitted`,
          );
        }
      } else if (value !== null && typeof value === "object") {
        scanDict(value as Record<string, unknown>);
      }
    }
  };

  // Structural descent for arrays that are NOT dict field values (args array,
  // ids lists) — never classified as commands; only their nested dicts matter.
  const walkStructural = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      for (const el of node) walkStructural(el);
    } else if (node !== null && typeof node === "object") {
      scanDict(node as Record<string, unknown>);
    }
  };

  if (Array.isArray(op.args)) walkStructural(op.args);
  if (op.kwargs !== null && typeof op.kwargs === "object") {
    scanDict(op.kwargs as Record<string, unknown>);
  }
}

/**
 * Minimal OdooClient surface the bridge needs. The real client satisfies it;
 * tests inject a stub (or a real client with a stubbed transport).
 */
export type QuoteRpcClient = Pick<OdooClient, "callMethod" | "searchRead">;

interface QuoteRpcOp {
  model: string;
  method: string;
  args: unknown[];
  kwargs?: Record<string, unknown>;
}

interface QuoteRpcParams {
  ops: QuoteRpcOp[];
  dry_run?: boolean;
  plan_token?: string;
  client_ref?: string;
}

// Recursively sort object keys (arrays keep their order) so JSON.stringify is a
// canonical serialization — the basis for the plan_token / idempotency hash.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * plan_token = "sha256:" + hex(sha256(canonical JSON of the ops array)).
 * Binds ARGS ONLY — never database state (the documented no-drift caveat).
 */
export function computePlanToken(ops: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(ops));
  return "sha256:" + createHash("sha256").update(canonicalJson).digest("hex");
}

// Target ids for the dry-run echo / summary. args[0] is a bare int (copy) or a
// list of ids (write/unlink). Anything else is unparseable -> empty + a note.
function extractTargetIds(args: unknown[]): {
  ids: number[];
  parseable: boolean;
} {
  const first = Array.isArray(args) ? args[0] : undefined;
  if (typeof first === "number" && Number.isInteger(first)) {
    return { ids: [first], parseable: true };
  }
  if (Array.isArray(first)) {
    const ids = first.filter(
      (x): x is number => typeof x === "number" && Number.isInteger(x),
    );
    return { ids, parseable: true };
  }
  return { ids: [], parseable: false };
}

function valsFieldList(vals: unknown): string {
  if (vals !== null && typeof vals === "object" && !Array.isArray(vals)) {
    const keys = Object.keys(vals as Record<string, unknown>);
    return keys.length ? ` — fields: ${keys.join(", ")}` : "";
  }
  return "";
}

function idsLabel(idInfo: { ids: number[]; parseable: boolean }): string {
  if (!idInfo.parseable) return "(target ids unparseable from args[0])";
  if (idInfo.ids.length === 0) return "(no target ids)";
  return `ids [${idInfo.ids.join(", ")}]`;
}

function summarizeOp(
  op: QuoteRpcOp,
  idInfo: { ids: number[]; parseable: boolean } | null,
): string {
  const args = Array.isArray(op.args) ? op.args : [];
  switch (op.method) {
    case "create":
      return `create ${op.model}${valsFieldList(args[0])}`;
    case "write":
      return `write ${op.model} ${idsLabel(idInfo ?? extractTargetIds(args))}${valsFieldList(args[1])}`;
    case "unlink":
      return `unlink ${op.model} ${idsLabel(idInfo ?? extractTargetIds(args))}`;
    case "copy": {
      const def =
        op.kwargs && typeof op.kwargs === "object"
          ? (op.kwargs as Record<string, unknown>).default
          : undefined;
      return `copy ${op.model} ${idsLabel(idInfo ?? extractTargetIds(args))}${valsFieldList(def)}`;
    }
    case "message_post": {
      const { ids } = extractTargetIds(args);
      return `message_post on ${op.model}${ids.length ? ` id ${ids[0]}` : ""}`;
    }
    case "action_recalculate_handling_costs": {
      const { ids } = extractTargetIds(args);
      return `action_recalculate_handling_costs on ${op.model}${ids.length ? ` ids [${ids.join(", ")}]` : ""}`;
    }
    default:
      return `${op.method} ${op.model}`;
  }
}

function faultMessage(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.faultString === "string" && anyErr.faultString.trim()) {
      return anyErr.faultString;
    }
    if (typeof anyErr.message === "string" && anyErr.message.trim()) {
      return anyErr.message;
    }
  }
  return String(err);
}

const QUOTE_RPC_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Hint for a per-RPC timeout (RpcTimeoutError from the client). A timeout is
// ambiguous — the write may or may not have committed on the Odoo side — so the
// skill must verify actual state before any retry, and MUST use a new
// client_ref (the old ref replays this stored failure by design; it never
// re-runs the ops).
const RPC_TIMEOUT_HINT =
  "the Odoo call exceeded the per-RPC timeout; the write may or may not have " +
  "landed — verify actual state via odoo_search_read before retrying, and " +
  "retry with a NEW client_ref (the old ref replays this stored failure by " +
  "design)";

// Hint for a non-timeout op failure (an Odoo fault / validation error).
const EXECUTION_FAILED_HINT =
  "one op failed; prior ops in this batch are already committed (no cross-op " +
  "transaction) — inspect results[].status, verify in Odoo, and use a NEW " +
  "client_ref for any corrected retry";

const QUOTE_RPC_DESCRIPTION =
  "TEMPORARY scoped XML-RPC bridge for quote editing: a model/method-" +
  "allowlisted execute_kw passthrough run with the gateway's Odoo credentials. " +
  "Within the permitted models you construct general execute_kw args — this is " +
  "DATA-LEVEL access (which records/fields), not a fixed set of typed actions. " +
  "It exists ONLY until the deterministic tools replace it — update_quote and " +
  "configure_addons (wave 2) and create_quote (wave 3); when those ship this " +
  "bridge is removed, so prefer them if present.\n\n" +
  "ALLOWED (model -> methods), enforced in plugin code before any RPC; anything " +
  "else returns op_not_permitted:\n" +
  "  - sale.order: create, write, copy, message_post, action_recalculate_handling_costs\n" +
  "  - sale.order.line: write, unlink\n" +
  "  - print.design: create, write, unlink\n" +
  "  - product.template: message_post ONLY\n" +
  "  - product.product: message_post ONLY\n" +
  "There is NO create/write/unlink/copy on product.template, product.product or " +
  "product.supplierinfo through this tool under any input. To create or change " +
  "product data use odoo_spawn_customer_product / odoo_create_custom_product " +
  "(the only product-creation route), or hand off to a human. print.design is " +
  "the only product-adjacent write.\n\n" +
  "NESTED WRITES: x2many command tuples in vals that CREATE/UPDATE/DELETE " +
  "related records (command codes 0/1/2/5) are rejected (unsafe_relational_write) " +
  "— they would cascade onto comodels (e.g. product.template via " +
  "product_to_archive_ids/pack_ids) and bypass the rule above. The ONE exception " +
  "is creating order lines on sale.order.create (order_line [[0,0,{...}]]); its " +
  "line vals are scanned the same way. Relation-only commands — link/unlink-" +
  "relation/replace (codes 3/4/6), e.g. tag_ids [[6,0,[ids]]] — are allowed.\n\n" +
  "BATCH: `ops` is an ordered array of {model, method, args, kwargs?}. `args` is " +
  "the standard execute_kw positional array (create [{vals}]; write " +
  "[[ids],{vals}]; unlink [[ids]]; copy [id] with optional kwargs.default; " +
  "message_post [[id]] with kwargs such as {body, subtype_xmlid}; " +
  "action_recalculate_handling_costs [[id]]). Ops run sequentially and STOP on " +
  "the first error; there is NO cross-op transaction, so earlier ops stay " +
  "committed if a later one fails — read results[].status.\n\n" +
  "TWO-STEP PLAN-VALIDATION FLOW: (1) call with dry_run:true — the tool " +
  "validates every op's scope and safety, reports all problems at once, and " +
  "returns a human-readable `plan` (each write/unlink/copy op echoes its target " +
  "records' id/display_name, plus state for sale.order) and a `plan_token`; " +
  "ZERO writes occur. (2) review the returned plan and warnings against the " +
  "request; then call again with dry_run:false, the SAME ops, that plan_token, " +
  "and a client_ref — the matching token guarantees what executes is exactly " +
  "what was validated.\n\n" +
  "PLAN_TOKEN — CONSISTENCY CHECK, NOT A HUMAN GATE: plan_token is a " +
  "deterministic sha256 of the canonical ops. It binds the ops' ARGS ONLY — " +
  "never database state — and does NOT record human review nor act as an " +
  "authorization boundary. It cannot tell whether the quote changed between " +
  "dry_run and execute, so the " +
  "calling skill MUST re-check for duplicates/state immediately before " +
  "executing.\n\n" +
  "IDEMPOTENCY: client_ref is required on execute. A repeat with the same " +
  "client_ref and identical ops replays the stored result " +
  "(idempotent_replay:true) without re-executing; the same client_ref with " +
  "different ops returns client_ref_conflict. The store is in-memory and is " +
  "cleared on gateway restart. There is NO automatic retry/backoff — client_ref " +
  "idempotency plus skill-side verification is the deliberate model.\n\n" +
  "PER-RPC TIMEOUT: each execute_kw is bounded by a per-RPC timeout (config " +
  "channels.odoo.rpcTimeoutMs, default 120s). A hung op fails with rpc_timeout " +
  "(prior ops executed, later ops not_run); the write may or may not have " +
  "landed, so verify state via odoo_search_read and retry with a NEW client_ref " +
  "(the old ref replays the stored failure by design).\n\n" +
  "Envelopes: errors -> {ok:false, errors:[{code, message, hint}]}; dry_run " +
  "success -> {ok:true, dry_run:true, plan, plan_token}; execute success -> " +
  "{ok:true, results:[...]}.";

export function createOdooQuoteRpcTool(
  cfg: OpenClawConfig,
  clientOverride?: QuoteRpcClient,
) {
  const registeredAccount = resolveAccount(cfg);
  const botSessionId = registeredAccount.botSessionId;

  // client_ref -> {opsHash, response}. In-memory, TTL 24h, lazy eviction.
  // Scoped to this tool instance; a gateway restart clears it (documented in
  // the tool description). registerFull runs once per account boot, so in
  // production this is a single store per gateway process.
  const idempotencyStore = new Map<
    string,
    { opsHash: string; response: Record<string, unknown>; storedAt: number }
  >();

  const readStore = (ref: string) => {
    const entry = idempotencyStore.get(ref);
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > QUOTE_RPC_IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(ref);
      return undefined;
    }
    return entry;
  };

  return () => ({
    name: "odoo_quote_rpc",
    label: "Odoo Quote RPC (scoped bridge)",
    description: QUOTE_RPC_DESCRIPTION,
    parameters: Type.Object(
      {
        ops: Type.Array(
          Type.Object(
            {
              model: Type.String({
                description:
                  "Odoo model. Allowed: sale.order, sale.order.line, " +
                  "print.design (writes); product.template / product.product " +
                  "(message_post only). Any other model -> op_not_permitted.",
              }),
              method: Type.String({
                description:
                  "Odoo method, allowlisted per model (see the scope table in " +
                  "the tool description). Any other pair -> op_not_permitted.",
              }),
              args: Type.Array(Type.Unknown(), {
                description:
                  "Standard execute_kw positional args: create [{vals}]; " +
                  "write [[ids],{vals}]; unlink [[ids]]; copy [id]; " +
                  "message_post [[id]]; action_recalculate_handling_costs " +
                  "[[id]].",
              }),
              kwargs: Type.Optional(
                Type.Object(
                  {},
                  {
                    // Passthrough bag for arbitrary Odoo kwargs — must stay
                    // open (additionalProperties:true) to carry e.g.
                    // {default:{...}} for copy or {body, subtype_xmlid} for
                    // message_post. Structure is NOT validated here.
                    additionalProperties: true,
                    description:
                      "Optional execute_kw keyword args, passed through " +
                      'verbatim. E.g. {"default": {...}} for copy, or ' +
                      '{"body": "…", "subtype_xmlid": "mail.mt_note"} for ' +
                      "message_post.",
                  },
                ),
              ),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            description:
              "Ordered batch of execute_kw operations. Run sequentially; " +
              "execution STOPS on the first failure and earlier ops stay " +
              "committed (no cross-op transaction).",
          },
        ),
        dry_run: Type.Optional(
          Type.Boolean({
            description:
              "Two-step plan-validation flow. Call FIRST with dry_run:true to " +
              "validate every op, get a human-readable `plan` (write/unlink/copy " +
              "ops echo their target records) and a `plan_token`, with ZERO " +
              "writes. Then review the plan against the request and call again " +
              "with dry_run:false, the SAME ops, the plan_token, and a " +
              "client_ref.",
          }),
        ),
        plan_token: Type.Optional(
          Type.String({
            description:
              "The plan_token from the matching dry_run. Required on execute " +
              "(dry_run:false). It is a consistency hash of the ops' ARGS ONLY " +
              "(not database state, not evidence of human review) — so the " +
              "calling skill must re-check for drift/duplicates immediately " +
              "before " +
              "executing. Missing -> plan_token_required; not matching the " +
              "submitted ops -> plan_token_mismatch.",
          }),
        ),
        client_ref: Type.Optional(
          Type.String({
            description:
              "Idempotency key, REQUIRED on execute. A repeat with the same " +
              "client_ref and identical ops replays the stored result " +
              "(idempotent_replay:true) without re-executing; the same " +
              "client_ref with different ops -> client_ref_conflict. The store " +
              "is in-memory and cleared on gateway restart. Ignored by dry_run.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId: string, params: QuoteRpcParams) => {
      const client: QuoteRpcClient = clientOverride ?? getToolClient(cfg);
      const ops: QuoteRpcOp[] = Array.isArray(params.ops) ? params.ops : [];

      const wrap = (envelope: Record<string, unknown>) => ({
        content: [
          { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
        ],
        details: undefined,
      });

      // Validation — shared by dry-run and execute (defense in depth on the
      // execute path). All violations are reported at once. Two gates: (1) the
      // (model, method) allowlist; (2) a recursive vals scan that rejects any
      // x2many command tuple which would cascade a create/update/delete onto a
      // comodel (the product-write bypass). An out-of-scope op is skipped for
      // the deeper scan — it is already dead.
      const violations: QuoteRpcViolation[] = [];
      ops.forEach((op, index) => {
        if (!isOpPermitted(op.model, op.method)) {
          violations.push({
            code: "op_not_permitted",
            message: `op[${index}] ${op.model}.${op.method} is not permitted by odoo_quote_rpc`,
            hint: opNotPermittedHint(op.model),
          });
          return;
        }
        scanForUnsafeCommands(op, index, violations);
      });

      // -------------------------------- DRY RUN ------------------------------
      if (params.dry_run === true) {
        if (violations.length > 0) {
          // Nothing is sent to Odoo if any op is out of scope or unsafe.
          return wrap({ ok: false, errors: violations });
        }

        const plan: Array<Record<string, unknown>> = [];
        for (let index = 0; index < ops.length; index++) {
          const op = ops[index];
          const needsEcho =
            op.method === "write" ||
            op.method === "unlink" ||
            op.method === "copy";
          const idInfo = needsEcho ? extractTargetIds(op.args) : null;
          const entry: Record<string, unknown> = {
            index,
            model: op.model,
            method: op.method,
            summary: summarizeOp(op, idInfo),
          };
          if (needsEcho) {
            let targets: Array<Record<string, unknown>> = [];
            if (idInfo && idInfo.ids.length > 0) {
              const fields =
                op.model === "sale.order"
                  ? ["display_name", "state"]
                  : ["display_name"];
              const records = await client.searchRead({
                model: op.model,
                domain: [["id", "in", idInfo.ids]],
                fields,
                limit: idInfo.ids.length,
                botSessionId,
              });
              targets = (records ?? []).map((r: Record<string, unknown>) => {
                const t: Record<string, unknown> = {
                  id: r.id,
                  display_name: r.display_name,
                };
                if (op.model === "sale.order" && "state" in r) t.state = r.state;
                return t;
              });
            }
            entry.targets = targets;
          }
          plan.push(entry);
        }

        return wrap({
          ok: true,
          dry_run: true,
          plan,
          plan_token: computePlanToken(ops),
        });
      }

      // -------------------------------- EXECUTE ------------------------------
      if (!params.plan_token) {
        return wrap({
          ok: false,
          errors: [
            {
              code: "plan_token_required",
              message: "execute requires the plan_token from a prior dry_run",
              hint:
                "call this tool with dry_run:true over the SAME ops to get a " +
                "plan_token, review the returned plan, then re-call with " +
                "dry_run:false plus that token",
            },
          ],
        });
      }

      const expectedToken = computePlanToken(ops);
      if (params.plan_token !== expectedToken) {
        return wrap({
          ok: false,
          errors: [
            {
              code: "plan_token_mismatch",
              message: "plan_token does not match the submitted ops",
              hint:
                "the ops differ from the validated dry_run (the token binds " +
                "args, not database state); re-run dry_run over the current " +
                "ops and use the fresh plan_token",
            },
          ],
        });
      }

      if (!params.client_ref) {
        return wrap({
          ok: false,
          errors: [
            {
              code: "client_ref_required",
              message: "execute requires a client_ref idempotency key",
              hint:
                "supply a stable, unique client_ref (e.g. a task/row id) so a " +
                "retried execute replays instead of re-running the ops",
            },
          ],
        });
      }

      const opsHash = expectedToken;

      // Idempotency — replay or conflict before any side effect.
      const stored = readStore(params.client_ref);
      if (stored) {
        if (stored.opsHash === opsHash) {
          return wrap({ ...stored.response, idempotent_replay: true });
        }
        return wrap({
          ok: false,
          errors: [
            {
              code: "client_ref_conflict",
              message: "client_ref was already used with a different set of ops",
              hint:
                "this client_ref is bound to different ops; use a NEW " +
                "client_ref for different work",
            },
          ],
        });
      }

      // Defense in depth: re-validate scope AND the x2many-cascade guard before
      // executing anything.
      if (violations.length > 0) {
        return wrap({ ok: false, errors: violations });
      }

      const results: Array<{
        index: number;
        model: string;
        method: string;
        status: "executed" | "failed" | "not_run";
        result?: unknown;
        error?: string;
      }> = [];
      let failure: string | null = null;
      // Distinguish a per-RPC timeout (ambiguous — write may have landed) from
      // an ordinary Odoo fault, so the failing op surfaces the right code/hint.
      let failureIsTimeout = false;

      for (let index = 0; index < ops.length; index++) {
        const op = ops[index];
        if (failure !== null) {
          results.push({
            index,
            model: op.model,
            method: op.method,
            status: "not_run",
          });
          continue;
        }
        try {
          const result = await client.callMethod({
            model: op.model,
            method: op.method,
            args: op.args,
            kwargs: op.kwargs,
            botSessionId,
          });
          results.push({
            index,
            model: op.model,
            method: op.method,
            status: "executed",
            result,
          });
        } catch (err) {
          failure = faultMessage(err);
          failureIsTimeout = err instanceof RpcTimeoutError;
          results.push({
            index,
            model: op.model,
            method: op.method,
            status: "failed",
            error: failure,
          });
        }
      }

      const response: Record<string, unknown> =
        failure !== null
          ? {
              ok: false,
              errors: [
                failureIsTimeout
                  ? {
                      code: "rpc_timeout",
                      message: failure,
                      hint: RPC_TIMEOUT_HINT,
                    }
                  : {
                      code: "execution_failed",
                      message: failure,
                      hint: EXECUTION_FAILED_HINT,
                    },
              ],
              results,
            }
          : { ok: true, results };

      // Record for idempotent replay — on success AND mid-batch failure, since
      // committed ops must not be re-run by a retry with the same client_ref.
      idempotencyStore.set(params.client_ref, {
        opsHash,
        response,
        storedAt: Date.now(),
      });

      return wrap(response);
    },
  });
}
