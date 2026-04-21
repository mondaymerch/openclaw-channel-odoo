/**
 * OpenClaw channel plugin for Odoo.
 *
 * Inbound:  Odoo chatter module POSTs to the configured webhookPath
 * Outbound: Agent replies via XML-RPC (configurable method)
 * Tool:     odoo_search_read — agent can query any Odoo model
 *
 * @see https://github.com/mondaymerch/openclaw-channel-odoo
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createDedupeCache } from "openclaw/plugin-sdk/infra-runtime";
import { createInboundDebouncer } from "openclaw/plugin-sdk/reply-runtime";
import { odooPlugin, resolveAccount } from "./channel.js";
import { setOdooRuntime } from "./runtime.js";
import { createOdooSearchReadTool } from "./tools.js";
import {
  CHANNEL_ID,
  createDispatchBatch,
  type InboundMessage,
} from "./dispatch.js";
import { createWebhookHandler } from "./webhook-handler.js";

// Batch rapid messages to the same record into one agent run.
const INBOUND_DEBOUNCE_MS = 3000;

// Covers Odoo's ~10s webhook retry window (RETRY_DELAYS [0.5, 1] +
// GATEWAY_TIMEOUT 3) with margin. Short enough that an operator Retry
// minutes later bypasses dedup and re-dispatches.
const DEDUPE_TTL_MS = 2 * 60 * 1000;
const DEDUPE_MAX_SIZE = 10_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry: any = defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Odoo",
  description: "Route AI conversations through Odoo chatter via XML-RPC",
  plugin: odooPlugin,
  setRuntime: setOdooRuntime,

  registerFull(api) {
    const account = resolveAccount(api.config);
    const clientConfig = {
      url: account.url,
      db: account.db,
      uid: account.uid,
      password: account.password,
    };

    api.registerTool(
      createOdooSearchReadTool(api.config),
      { name: "odoo_search_read" },
    );

    const dedupe = createDedupeCache({
      ttlMs: DEDUPE_TTL_MS,
      maxSize: DEDUPE_MAX_SIZE,
    });

    const dispatchBatch = createDispatchBatch({ api, account, clientConfig });

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: INBOUND_DEBOUNCE_MS,
      buildKey: (item) => `${item.model}:${item.res_id}`,
      onFlush: dispatchBatch,
      onError: (err, items) => {
        const key = items[0] ? `${items[0].model}:${items[0].res_id}` : "?";
        api.logger.error(`[odoo] Debouncer flush error for ${key}: ${err}`);
      },
    });

    api.registerHttpRoute({
      path: account.webhookPath,
      auth: "plugin",
      handler: createWebhookHandler({ api, dedupe, debouncer }),
    });

    api.logger.info(
      `[odoo] Channel plugin loaded — webhook at ${account.webhookPath}`,
    );
  },
});

export default entry;
