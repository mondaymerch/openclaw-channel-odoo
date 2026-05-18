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
  createDispatchHandler,
  type DispatchHandler,
  type InboundMessage,
} from "./dispatch.js";
import { createDebouncerAdapter } from "./debouncer-adapter.js";
import { createInboxQueue } from "./inbox/queue.js";
import { createRecordLock } from "./inbox/record-lock.js";
import { runBootRecovery } from "./inbox/recovery.js";
import { createRetryScheduler } from "./inbox/scheduler.js";
import {
  ensureInboxQueueDirs,
  resolveInboxQueuePaths,
  resolveStateDir,
} from "./inbox/store.js";
import { createWebhookHandler } from "./webhook-handler.js";

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

    // Persistent inbox — disk paths, lock, queue.
    const inboxPaths = resolveInboxQueuePaths(resolveStateDir());
    const inboxLock = createRecordLock();
    const inboxQueue = createInboxQueue({ paths: inboxPaths, lock: inboxLock });

    // Scheduler and dispatch handler form a construction cycle: the
    // scheduler needs `processBatch`, and `processBatch` needs the
    // scheduler for handleFailure. Resolved by handing the scheduler a
    // closure that dereferences `dispatchHandler` lazily — assigned
    // immediately below, so it's always populated at call time.
    let dispatchHandler: DispatchHandler | undefined;
    const scheduler = createRetryScheduler({
      paths: inboxPaths,
      queue: inboxQueue,
      processBatch: (batch) => {
        if (!dispatchHandler) {
          throw new Error(
            "[odoo] dispatchHandler not constructed yet — bug in plugin wiring",
          );
        }
        return dispatchHandler.processBatch(batch);
      },
      logger: api.logger,
    });

    dispatchHandler = createDispatchHandler({
      api,
      account,
      clientConfig,
      queue: inboxQueue,
      scheduler,
      hardTimeoutMs: account.agentTimeoutMs,
    });

    const onFlush = createDebouncerAdapter({
      paths: inboxPaths,
      processBatch: (b) => dispatchHandler!.processBatch(b),
      logger: api.logger,
    });

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: account.debounceMs,
      // Lane key must match the queue's `(model, res_id, routing_key)` batch
      // identity so the in-memory debounce window doesn't blur messages
      // meant for different routing-key lanes.
      buildKey: (item) =>
        `${item.model}:${item.res_id}:${item.routing_key ?? ""}`,
      onFlush,
      onError: (err, items) => {
        const key = items[0] ? `${items[0].model}:${items[0].res_id}` : "?";
        api.logger.error(`[odoo] Debouncer flush error for ${key}: ${err}`);
      },
    });

    // Ready-gate: webhook returns 503 until boot recovery finishes the
    // disk-state partition pass. Odoo retries 5xx, so no message is
    // dropped during the window. registerFull is sync; recovery is
    // async — we register the route synchronously to avoid a 404 window.
    let ready = false;
    api.registerHttpRoute({
      path: account.webhookPath,
      auth: "plugin",
      handler: createWebhookHandler({
        api,
        dedupe,
        debouncer,
        queue: inboxQueue,
        isReady: () => ready,
      }),
    });

    void (async () => {
      try {
        await ensureInboxQueueDirs(inboxPaths);
        const summary = await runBootRecovery({
          paths: inboxPaths,
          queue: inboxQueue,
          scheduler,
          logger: api.logger,
          agentTimeoutMs: account.agentTimeoutMs,
        });
        api.logger.info(
          `[odoo] inbox.recovery complete — total=${summary.total} ` +
            `eligibleReceived=${summary.eligibleReceived} ` +
            `replyReady=${summary.eligibleReplyReady} ` +
            `deferred=${summary.deferred} expired=${summary.expired} ` +
            `corrupt=${summary.corrupt}`,
        );
        ready = true;
      } catch (err) {
        // If we can't partition disk state, we don't know what's safe to
        // dispatch. Stay in 503-mode so we don't pile new traffic on top
        // of an unknown-state inbox. Operator must intervene.
        api.logger.error(
          `[odoo] inbox.recovery FAILED — plugin stays in not-ready state: ${err}`,
        );
      }
    })();

    api.logger.info(
      `[odoo] Channel plugin loaded — webhook at ${account.webhookPath} (recovering...)`,
    );
  },
});

export default entry;
