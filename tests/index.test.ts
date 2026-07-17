/**
 * Tests for src/index.ts — plugin registration lifecycle.
 *
 * Run: npx tsx --test tests/index.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import entry, {
  resetOdooChannelSideEffectsForTests,
} from "../src/index.js";

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
            reply: {
              method: "message_post",
              args: ["body", "requestMessageId"],
            },
          },
        ],
      },
    },
  };
}

function makeApi(config = buildConfig()) {
  const infos: string[] = [];
  const debugs: string[] = [];
  const errors: string[] = [];
  const tools: string[] = [];
  const routes: unknown[] = [];
  const channels: unknown[] = [];

  return {
    api: {
      id: "odoo",
      name: "Odoo",
      source: "test",
      registrationMode: "full",
      config,
      runtime: {},
      logger: {
        debug: (m: string) => debugs.push(m),
        info: (m: string) => infos.push(m),
        warn: () => undefined,
        error: (m: string) => errors.push(m),
      },
      registerTool: (_tool: unknown, opts?: { name?: string }) => {
        tools.push(opts?.name ?? "");
      },
      registerChannel: (registration: unknown) => {
        channels.push(registration);
      },
      registerHttpRoute: (route: unknown) => {
        routes.push(route);
      },
    },
    infos,
    debugs,
    errors,
    tools,
    routes,
    channels,
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for condition");
}

test("registerFull keeps tool registration repeatable but starts channel side effects once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odoo-plugin-index-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetOdooChannelSideEffectsForTests();

  try {
    const harness = makeApi();

    entry.register(harness.api);
    entry.register(harness.api);

    await waitFor(
      () => harness.infos.filter((m) => m.includes("inbox.recovery complete")).length === 1,
    );

    assert.equal(harness.channels.length, 2, "channel capability is still registered per load");
    assert.deepEqual(harness.tools, [
      "odoo_search_read",
      "odoo_spawn_customer_product",
      "odoo_create_custom_product",
      "odoo_search_read",
      "odoo_spawn_customer_product",
      "odoo_create_custom_product",
    ]);
    assert.equal(harness.routes.length, 1, "webhook route must not be registered twice");
    assert.equal(
      harness.infos.filter((m) => m.includes("Channel plugin loaded")).length,
      1,
      "boot recovery should only be started once",
    );
    assert.ok(
      harness.debugs.some((m) => m.includes("skipping duplicate recovery")),
      "duplicate load should be explicitly logged at debug level",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    resetOdooChannelSideEffectsForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});
