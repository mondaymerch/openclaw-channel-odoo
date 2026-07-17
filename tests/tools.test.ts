/**
 * Tests for the product-creation agent tools' TypeBox parameter schemas.
 *
 * These validate the schema layer only — no RPC, no network. They pin the
 * PR-2 acceptance criterion "a schema-invalid payload is rejected client-side
 * by the TypeBox schema before any RPC", the counterpart "the spec's example
 * payloads are accepted", and `additionalProperties: false` rejection of the
 * fields the agent must never be able to pass (partner, list_price, …).
 *
 * The schemas deliberately enforce STRUCTURE only (field names, types,
 * required-ness, enum membership, additionalProperties:false). VALUE semantics
 * (positivity, ranges, id existence, vendor ambiguity, dedup) are validated by
 * the agent.api Odoo method so it can return every problem in one structured
 * response — so we do NOT assert here that e.g. quantity:0 is rejected.
 *
 * Run: npx tsx --test tests/tools.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";

import {
  createOdooSpawnCustomerProductTool,
  createOdooCreateCustomProductTool,
} from "../src/tools.js";

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
const spawnTool = createOdooSpawnCustomerProductTool(cfg)();
const customTool = createOdooCreateCustomProductTool(cfg)();

// The exact JSON blocks from OPENCLAW_AGENT_API_SPEC.md (Action 1 / Action 2).
const spawnSpecPayload = {
  parent_variant_id: 123,
  platform_id: 13600,
  print_configuration_ids: [55, 56],
  custom_name: "…",
  target_so: { id: 456 },
  quantity: 100,
  client_ref: "task29635-row1",
  dry_run: true,
  plan_token: "sha256:…",
};

const customSpecPayload = {
  name: "Organic Cotton T-Shirt (Red) Digital Transfer – Front & Back + Neck Print",
  platform_id: 13600,
  vendor: { id: 8412 },
  vendor_url: "https://example.invalid/p",
  vendor_sku: "MO9678",
  quantity: 214,
  unit_cost: 7.06,
  cost_currency: "EUR",
  lead_time_days: 8,
  sales_factor: 1.7,
  design_difficulty: "easy",
  quick_reference_product_id: 4711,
  dimensions: { length: 30, width: 20, height: 2, unit: "cm" },
  dims_source: "vendor_page",
  weight: { value: 0.2, unit: "kg" },
  decorations: ["2x digital transfer (front+back)", "1x transfer (neck)"],
  target_so: { name: "S361175" },
  client_ref: "task29635-row1",
  dry_run: true,
  plan_token: "sha256:…",
};

test("tool identity: names and labels are stable", () => {
  assert.equal(spawnTool.name, "odoo_spawn_customer_product");
  assert.equal(customTool.name, "odoo_create_custom_product");
  assert.equal(spawnTool.label, "Odoo Spawn Customer Product");
  assert.equal(customTool.label, "Odoo Create Custom Product");
});

test("spawn: accepts the spec example payload", () => {
  assert.ok(
    Value.Check(spawnTool.parameters, spawnSpecPayload),
    () => JSON.stringify([...Value.Errors(spawnTool.parameters, spawnSpecPayload)], null, 2),
  );
});

test("spawn: accepts a minimal required-only payload (target_so absent)", () => {
  const payload = {
    parent_variant_id: 123,
    platform_id: 13600,
    print_configuration_ids: [],
  };
  assert.ok(Value.Check(spawnTool.parameters, payload));
});

test("spawn: accepts target_so identified by name", () => {
  const payload = {
    parent_variant_id: 123,
    platform_id: 13600,
    print_configuration_ids: [55],
    target_so: { name: "S376204" },
    quantity: 10,
  };
  assert.ok(Value.Check(spawnTool.parameters, payload));
});

test("spawn: rejects forbidden field `partner` (additionalProperties:false)", () => {
  const payload = { ...spawnSpecPayload, partner: 999 };
  assert.equal(Value.Check(spawnTool.parameters, payload), false);
});

test("spawn: rejects forbidden field `set_internal_review`", () => {
  const payload = { ...spawnSpecPayload, set_internal_review: true };
  assert.equal(Value.Check(spawnTool.parameters, payload), false);
});

test("spawn: rejects a missing required field (platform_id)", () => {
  const { platform_id: _omit, ...payload } = spawnSpecPayload;
  assert.equal(Value.Check(spawnTool.parameters, payload), false);
});

test("spawn: rejects a wrong-typed id (parent_variant_id as string)", () => {
  const payload = { ...spawnSpecPayload, parent_variant_id: "123" };
  assert.equal(Value.Check(spawnTool.parameters, payload), false);
});

test("spawn: rejects a non-integer array element in print_configuration_ids", () => {
  const payload = { ...spawnSpecPayload, print_configuration_ids: [55, "56"] };
  assert.equal(Value.Check(spawnTool.parameters, payload), false);
});

test("spawn: rejects an unknown key inside target_so", () => {
  const payload = { ...spawnSpecPayload, target_so: { id: 456, foo: 1 } };
  assert.equal(Value.Check(spawnTool.parameters, payload), false);
});

test("custom: accepts the spec example payload", () => {
  assert.ok(
    Value.Check(customTool.parameters, customSpecPayload),
    () => JSON.stringify([...Value.Errors(customTool.parameters, customSpecPayload)], null, 2),
  );
});

test("custom: accepts a minimal required-only payload", () => {
  const payload = {
    name: "Bespoke widget",
    platform_id: 13600,
    vendor: { name: "Midocean" },
    quantity: 100,
    unit_cost: 3.5,
    lead_time_days: 5,
    design_difficulty: "standard",
    quick_reference_product_id: 4711,
  };
  assert.ok(
    Value.Check(customTool.parameters, payload),
    () => JSON.stringify([...Value.Errors(customTool.parameters, payload)], null, 2),
  );
});

test("custom: accepts vendor by name", () => {
  const payload = { ...customSpecPayload, vendor: { name: "Midocean" } };
  assert.ok(Value.Check(customTool.parameters, payload));
});

test("custom: cost_currency IS a legitimate field", () => {
  // Guards against over-tightening: cost_currency is a real, accepted field
  // (used only for the currency_mismatch safety check server-side).
  const payload = { ...customSpecPayload, cost_currency: "USD" };
  assert.ok(Value.Check(customTool.parameters, payload));
});

test("custom: rejects forbidden field `list_price`", () => {
  const payload = { ...customSpecPayload, list_price: 99 };
  assert.equal(Value.Check(customTool.parameters, payload), false);
});

test("custom: rejects forbidden derived fields (company_id, currency_id, categ_id, print_design_ids)", () => {
  for (const key of ["company_id", "currency_id", "categ_id", "hs_code", "mm_partner_id", "print_design_ids"]) {
    const payload = { ...customSpecPayload, [key]: 1 };
    assert.equal(
      Value.Check(customTool.parameters, payload),
      false,
      `forbidden field "${key}" must be rejected by additionalProperties:false`,
    );
  }
});

test("custom: rejects a missing required field (name)", () => {
  const { name: _omit, ...payload } = customSpecPayload;
  assert.equal(Value.Check(customTool.parameters, payload), false);
});

test("custom: rejects a wrong-typed platform_id (string)", () => {
  const payload = { ...customSpecPayload, platform_id: "13600" };
  assert.equal(Value.Check(customTool.parameters, payload), false);
});

test("custom: rejects an out-of-enum design_difficulty", () => {
  const payload = { ...customSpecPayload, design_difficulty: "medium" };
  assert.equal(Value.Check(customTool.parameters, payload), false);
});

test("custom: rejects an out-of-enum dims_source", () => {
  const payload = { ...customSpecPayload, dims_source: "guessed" };
  assert.equal(Value.Check(customTool.parameters, payload), false);
});

test("custom: rejects an unknown key inside dimensions", () => {
  const payload = {
    ...customSpecPayload,
    dimensions: { length: 30, width: 20, height: 2, unit: "cm", depth: 5 },
  };
  assert.equal(Value.Check(customTool.parameters, payload), false);
});

test("custom: rejects an unknown key inside vendor", () => {
  const payload = { ...customSpecPayload, vendor: { id: 8412, alias: "x" } };
  assert.equal(Value.Check(customTool.parameters, payload), false);
});
