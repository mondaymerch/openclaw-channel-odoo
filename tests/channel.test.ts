/**
 * Tests for src/channel.ts — resolveAccount config validation for the
 * tunable knobs `debounceMs` and `agentTimeoutMs`.
 *
 * Run: npx tsx --test tests/channel.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveAccount } from "../src/channel.js";
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
