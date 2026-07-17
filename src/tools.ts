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
 * (validation, dedup, dry-run/approval, idempotency, VAT/price correctness)
 * lives in the `agent.api` Odoo model. These tools forward the payload as the
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

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { OdooClient } from "./client.js";
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
// two-step approval flow and idempotency identically).

const dryRunField = Type.Optional(
  Type.Boolean({
    description:
      "Two-step approval flow. Call FIRST with dry_run:true to get a preview " +
      "`plan` plus a `plan_token`, and ZERO writes. After a human approves the " +
      "plan, call again with dry_run:false, the SAME payload, plus that " +
      "plan_token to execute.",
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
      "execute while server-side approval is enabled for this action (the " +
      "default). It guarantees that what the human approved is exactly what " +
      "executes; a wrong/absent token returns plan_token_mismatch/" +
      "plan_token_required.",
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
      "dry-run/approval flow server-side and returns a structured response " +
      "envelope (never a raw traceback). ALWAYS call with dry_run:true first, " +
      "present the returned plan to a human, then execute with the plan_token. " +
      "When target_so is set, the appended line's partner is always derived " +
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
      "server-side, and enforces the two-step dry-run/approval flow. It returns " +
      "a structured response envelope (never a raw traceback). ALWAYS call with " +
      "dry_run:true first, present the plan (including its warnings) to a human, " +
      "then execute with the plan_token. To spawn a catalogue child instead, " +
      "use odoo_spawn_customer_product.",
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
