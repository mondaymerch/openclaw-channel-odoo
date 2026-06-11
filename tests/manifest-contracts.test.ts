/**
 * Tests for openclaw.plugin.json — tool contract declarations.
 *
 * Regression guard for v0.4.3: current OpenClaw core (>= 2026.5.31) refuses to
 * register an agent tool unless its name is declared under `contracts.tools` in
 * the manifest. A missing declaration is not a hard error — core logs a
 * diagnostic and returns without registering — so the tool silently vanishes
 * from every agent's tool surface. This asserts the manifest declares every
 * tool the plugin actually registers, so adding a new tool without declaring it
 * fails here instead of in production.
 *
 * Run: npx tsx --test tests/manifest-contracts.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import entry from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8"),
);

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

/** Capture the tool names the plugin registers during registerFull. */
function collectRegisteredToolNames(): string[] {
  const tools: string[] = [];
  const api = {
    id: "odoo",
    name: "Odoo",
    source: "test",
    registrationMode: "full",
    config: buildConfig(),
    runtime: {},
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    registerTool: (_tool: unknown, opts?: { name?: string; names?: string[] }) => {
      for (const n of [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])]) {
        tools.push(n);
      }
    },
    registerChannel: () => undefined,
    registerHttpRoute: () => undefined,
  };
  entry.register(api);
  return tools;
}

test("manifest declares odoo_search_read under contracts.tools", () => {
  assert.ok(
    Array.isArray(manifest?.contracts?.tools),
    "openclaw.plugin.json must declare contracts.tools (array) — core won't register agent tools otherwise",
  );
  assert.ok(
    manifest.contracts.tools.includes("odoo_search_read"),
    "contracts.tools must declare odoo_search_read",
  );
});

test("every registered tool is declared in contracts.tools", () => {
  const declared: string[] = manifest?.contracts?.tools ?? [];
  const registered = collectRegisteredToolNames();
  for (const name of registered) {
    assert.ok(
      declared.includes(name),
      `tool "${name}" is registered but not declared in contracts.tools — core will refuse to register it`,
    );
  }
});
