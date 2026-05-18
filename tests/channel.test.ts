/**
 * Tests for src/channel.ts — resolveAccount config validation for the
 * tunable knobs `debounceMs` and `agentTimeoutMs`.
 *
 * Run: npx tsx --test tests/channel.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  compileRoutes,
  findRouteForInbound,
  resolveAccount,
} from "../src/channel.js";
import {
  HARD_TIMEOUT_MS,
  INBOUND_DEBOUNCE_MS,
  REPLAY_TTL_MS,
} from "../src/inbox/types.js";

// Minimal valid section; tests vary just the field under test.
function buildCfg(overrides: Record<string, unknown> = {}) {
  return {
    channels: {
      odoo: {
        url: "https://example.com",
        db: "test_db",
        uid: 1,
        password: "key",
        webhookSecret: "secret",
        webhookPath: "/odoo/chatter",
        routes: [
          {
            match: "*",
            reply: { method: "message_post", args: ["body", "requestMessageId"] },
          },
        ],
        ...overrides,
      },
    },
  // resolveAccount only reads channels.odoo; the rest of OpenClawConfig is
  // intentionally not exercised here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("debounceMs defaults to INBOUND_DEBOUNCE_MS when omitted", () => {
  const account = resolveAccount(buildCfg());
  assert.equal(account.debounceMs, INBOUND_DEBOUNCE_MS);
});

test("agentTimeoutMs defaults to HARD_TIMEOUT_MS when omitted", () => {
  const account = resolveAccount(buildCfg());
  assert.equal(account.agentTimeoutMs, HARD_TIMEOUT_MS);
});

test("debounceMs override is surfaced on the resolved account", () => {
  const account = resolveAccount(buildCfg({ debounceMs: 500 }));
  assert.equal(account.debounceMs, 500);
});

test("agentTimeoutMs override is surfaced on the resolved account", () => {
  const account = resolveAccount(buildCfg({ agentTimeoutMs: 600_000 }));
  assert.equal(account.agentTimeoutMs, 600_000);
});

test("debounceMs: 0 (no debounce) is accepted as the lower bound", () => {
  const account = resolveAccount(buildCfg({ debounceMs: 0 }));
  assert.equal(account.debounceMs, 0);
});

test("debounceMs: negative is rejected with a clear error", () => {
  assert.throws(
    () => resolveAccount(buildCfg({ debounceMs: -1 })),
    /debounceMs: must be an integer in \[0, 60000\] \(got -1\)/,
  );
});

test("debounceMs: non-integer is rejected", () => {
  assert.throws(
    () => resolveAccount(buildCfg({ debounceMs: 1.5 })),
    /debounceMs: must be an integer/,
  );
});

test("debounceMs: above 60_000 is rejected", () => {
  assert.throws(
    () => resolveAccount(buildCfg({ debounceMs: 60_001 })),
    /debounceMs: must be an integer in \[0, 60000\]/,
  );
});

test("agentTimeoutMs: below 30_000 is rejected", () => {
  assert.throws(
    () => resolveAccount(buildCfg({ agentTimeoutMs: 29_999 })),
    /agentTimeoutMs: must be an integer/,
  );
});

test("agentTimeoutMs > REPLAY_TTL_MS is rejected (would let TTL fire before timeout)", () => {
  assert.throws(
    () => resolveAccount(buildCfg({ agentTimeoutMs: REPLAY_TTL_MS + 1 })),
    /agentTimeoutMs: must be an integer in \[30000, 3600000\]/,
  );
});

test("agentTimeoutMs exactly at REPLAY_TTL_MS is accepted (boundary)", () => {
  const account = resolveAccount(buildCfg({ agentTimeoutMs: REPLAY_TTL_MS }));
  assert.equal(account.agentTimeoutMs, REPLAY_TTL_MS);
});

// ===========================================================================
// compileMatch — routing-key validation
// ===========================================================================

const VALID_REPLY = {
  method: "message_post",
  args: ["body", "requestMessageId"],
};

function withMatches(matches: unknown[]): { routes: unknown[] } {
  return {
    routes: [
      ...matches.map((m) => ({ match: m, reply: VALID_REPLY })),
      { match: "*", reply: VALID_REPLY }, // catchall trailer required
    ],
  };
}

test("compileMatch: { routingKey: '<glob>' } is accepted", () => {
  const cfg = buildCfg(withMatches([{ routingKey: "purchase.receipt.*" }]));
  assert.doesNotThrow(() => resolveAccount(cfg));
});

test("compileMatch: { model: '<glob>', routingKey: '<glob>' } is accepted (AND)", () => {
  const cfg = buildCfg(
    withMatches([{ model: "crm.lead", routingKey: "first_contact" }]),
  );
  assert.doesNotThrow(() => resolveAccount(cfg));
});

test("compileMatch: bare non-catchall string is rejected (no shorthand)", () => {
  const cfg = buildCfg(withMatches(["purchase.receipt.scheduled_date_response"]));
  assert.throws(
    () => resolveAccount(cfg),
    /must be "\*", \{ model: "<glob>" \}, \{ routingKey: "<glob>" \}/,
  );
});

test("compileMatch: empty match object is rejected", () => {
  const cfg = buildCfg(withMatches([{}]));
  assert.throws(
    () => resolveAccount(cfg),
    /must include "model" and\/or "routingKey"/,
  );
});

test("compileMatch: empty-string routingKey is rejected", () => {
  const cfg = buildCfg(withMatches([{ routingKey: "" }]));
  assert.throws(() => resolveAccount(cfg), /routingKey: required non-empty string/);
});

test("compileMatch: non-string routingKey is rejected", () => {
  const cfg = buildCfg(withMatches([{ routingKey: 123 }]));
  assert.throws(() => resolveAccount(cfg), /routingKey: required non-empty string/);
});

// ===========================================================================
// findRouteForInbound — resolution semantics
// ===========================================================================

function r(match: unknown, agentId: string) {
  return {
    match,
    agentId,
    reply: { method: "message_post", args: ["body", "requestMessageId"] },
  };
}

test("findRouteForInbound: { model, routingKey } combined match wins over model-only", () => {
  const routes = compileRoutes([
    r({ model: "crm.lead", routingKey: "first_contact" }, "onboarding"),
    r({ routingKey: "*.urgent" }, "escalation"),
    r({ model: "crm.lead" }, "lead_handler"),
    r("*", "catchall"),
  ]);
  const hit = findRouteForInbound(routes, {
    model: "crm.lead",
    routingKey: "first_contact",
  });
  assert.equal(hit.agentId, "onboarding");
});

test("findRouteForInbound: routingKey-only route matches across models", () => {
  const routes = compileRoutes([
    r({ model: "crm.lead", routingKey: "first_contact" }, "onboarding"),
    r({ routingKey: "*.urgent" }, "escalation"),
    r({ model: "crm.lead" }, "lead_handler"),
    r("*", "catchall"),
  ]);
  const hit = findRouteForInbound(routes, {
    model: "helpdesk.ticket",
    routingKey: "support.urgent",
  });
  assert.equal(hit.agentId, "escalation");
});

test("findRouteForInbound: missing routingKey falls past routing-key routes", () => {
  const routes = compileRoutes([
    r({ routingKey: "*.urgent" }, "escalation"),
    r({ model: "crm.lead" }, "lead_handler"),
    r("*", "catchall"),
  ]);
  const hit = findRouteForInbound(routes, { model: "crm.lead" });
  assert.equal(hit.agentId, "lead_handler");
});

test("findRouteForInbound: null routingKey falls past routing-key routes (same as missing)", () => {
  const routes = compileRoutes([
    r({ routingKey: "*.urgent" }, "escalation"),
    r({ model: "crm.lead" }, "lead_handler"),
    r("*", "catchall"),
  ]);
  const hit = findRouteForInbound(routes, {
    model: "crm.lead",
    routingKey: null,
  });
  assert.equal(hit.agentId, "lead_handler");
});

test("findRouteForInbound: unmatched model+routingKey lands on catchall", () => {
  const routes = compileRoutes([
    r({ model: "crm.lead" }, "lead_handler"),
    r("*", "catchall"),
  ]);
  const hit = findRouteForInbound(routes, {
    model: "sale.order",
    routingKey: "anything",
  });
  assert.equal(hit.agentId, "catchall");
});

test("findRouteForInbound: combined match requires BOTH model and routingKey to match", () => {
  const routes = compileRoutes([
    r({ model: "crm.lead", routingKey: "first_contact" }, "onboarding"),
    r({ model: "crm.lead" }, "lead_handler"),
    r("*", "catchall"),
  ]);
  // Model matches, but routingKey doesn't → combined route skips
  const hit = findRouteForInbound(routes, {
    model: "crm.lead",
    routingKey: "different",
  });
  assert.equal(hit.agentId, "lead_handler");
});

test("$routingKey is a known variable in reply args", () => {
  const cfg = buildCfg({
    routes: [
      {
        match: { routingKey: "test" },
        reply: {
          method: "scheduled_date_response",
          args: ["body", "routingKey"],
        },
      },
      { match: "*", reply: VALID_REPLY },
    ],
  });
  assert.doesNotThrow(() => resolveAccount(cfg));
});

test("$routingKey is a known variable in reply kwargs ($-prefixed)", () => {
  const cfg = buildCfg({
    routes: [
      {
        match: { routingKey: "test" },
        reply: {
          method: "scheduled_date_response",
          kwargs: { tag: "$routingKey" },
        },
      },
      { match: "*", reply: VALID_REPLY },
    ],
  });
  assert.doesNotThrow(() => resolveAccount(cfg));
});
