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
import { odooPlugin, resolveAccount, getClient } from "./channel.js";
import { setOdooRuntime, getOdooRuntime } from "./runtime.js";
import { createOdooSearchReadTool } from "./tools.js";

// Batch rapid messages to the same record into one agent run.
const INBOUND_DEBOUNCE_MS = 3000;

// Covers Odoo's ~10s webhook retry window (RETRY_DELAYS [0.5, 1] +
// GATEWAY_TIMEOUT 3) with margin. Short enough that an operator Retry
// minutes later bypasses dedup and re-dispatches.
const DEDUPE_TTL_MS = 2 * 60 * 1000;
const DEDUPE_MAX_SIZE = 10_000;

type InboundMessage = {
  model: string;
  res_id: number;
  body: string;
  message_id: number;
  user_name?: string;
  partner_id?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry: any = defineChannelPluginEntry({
  id: "odoo",
  name: "Odoo",
  description: "Route AI conversations through Odoo chatter via XML-RPC",
  plugin: odooPlugin,
  setRuntime: setOdooRuntime,

  registerFull(api) {
    const account = resolveAccount(api.config);
    const webhookPath = account.webhookPath;

    // Register agent tool
    api.registerTool(
      createOdooSearchReadTool(api.config),
      { name: "odoo_search_read" },
    );

    const dedupe = createDedupeCache({
      ttlMs: DEDUPE_TTL_MS,
      maxSize: DEDUPE_MAX_SIZE,
    });

    const dispatchBatch = async (items: InboundMessage[]) => {
      if (items.length === 0) return;
      const last = items[items.length - 1];
      const { model, res_id } = last;
      const peerId = `${model}:${res_id}`;
      const combinedBody = items.map((i) => i.body).join("\n\n");
      const messageIds = items.map((i) => String(i.message_id));

      try {
        const rt = getOdooRuntime();
        const cfg = api.config;

        const route = rt.channel.routing.resolveAgentRoute({
          cfg,
          channel: "odoo",
          accountId: "default",
          peer: { kind: "direct", id: peerId },
        });

        const ctx = rt.channel.reply.finalizeInboundContext({
          Body: combinedBody,
          BodyForAgent: combinedBody,
          RawBody: combinedBody,
          CommandBody: combinedBody,
          From: `odoo:partner:${last.partner_id}`,
          To: `odoo:record:${peerId}`,
          SessionKey: route.sessionKey,
          AccountId: "default",
          ChatType: "direct",
          SenderId: String(last.partner_id),
          SenderName: last.user_name ?? "Odoo User",
          Provider: "odoo",
          Surface: "odoo",
          MessageSid: String(last.message_id),
          MessageSids: messageIds,
          MessageSidFirst: messageIds[0],
          MessageSidLast: messageIds[messageIds.length - 1],
          Timestamp: Date.now(),
          OriginatingChannel: "odoo",
          OriginatingTo: `odoo:record:${peerId}`,
          CommandAuthorized: false,
        });

        const storePath = rt.channel.session.resolveStorePath(
          cfg.session?.store,
          { agentId: route.agentId },
        );
        await rt.channel.session.recordInboundSession({
          storePath,
          sessionKey: route.sessionKey,
          ctx,
          updateLastRoute: {
            sessionKey: route.mainSessionKey,
            channel: "odoo",
            to: `odoo:record:${peerId}`,
            accountId: "default",
          },
          onRecordError: (err: unknown) => {
            api.logger.error(`[odoo] Session record error: ${err}`);
          },
        });

        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          cfg,
          dispatcherOptions: {
            deliver: async (replyPayload: { text?: string }) => {
              const text = replyPayload?.text;
              if (!text) return;

              api.logger.info(
                `[odoo] Delivering reply to ${model},${res_id}`,
              );

              const client = getClient({
                url: account.url,
                db: account.db,
                uid: account.uid,
                password: account.password,
              });

              await client.callReply({
                model,
                resId: res_id,
                body: text,
                requestMessageId: last.message_id,
                method: account.replyMethod,
                argNames: account.replyArgs,
                botSessionId: account.botSessionId,
              });
            },
            onError: (err: unknown) => {
              api.logger.error(`[odoo] Reply dispatch error: ${err}`);
            },
          },
        });
      } catch (err) {
        api.logger.error(
          `[odoo] Failed to dispatch batch for ${peerId} (${items.length} msg): ${err}`,
        );
      }
    };

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
      path: webhookPath,
      auth: "plugin",
      handler: async (req, res) => {
        // Verify Bearer token
        const section = (api.config.channels as Record<string, any>)?.["odoo"];
        const secret = section?.webhookSecret;

        if (secret) {
          const authHeader = req.headers.authorization ?? "";
          if (authHeader !== `Bearer ${secret}`) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return true;
          }
        }

        // Parse body
        let payload: any;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return true;
        }

        const { model, res_id, body, message_id, user_name, partner_id } = payload;

        if (!model || !res_id || !body) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "model, res_id, and body are required" }));
          return true;
        }

        // Dedup: drop webhook retries from Odoo's own controller retry logic.
        // Operator-initiated Retry (minutes later) will bypass this and
        // re-dispatch.
        if (dedupe.check(String(message_id))) {
          api.logger.info(
            `[odoo] Duplicate message_id ${message_id} on ${model},${res_id} — skipping`,
          );
          res.statusCode = 202;
          res.end(JSON.stringify({ accepted: true, duplicate: true }));
          return true;
        }

        api.logger.info(
          `[odoo] Inbound from ${user_name ?? "unknown"} on ${model},${res_id}`,
        );

        // ACK immediately
        res.statusCode = 202;
        res.end(JSON.stringify({ accepted: true, message_id }));

        // Debouncer batches rapid messages to the same record; onFlush
        // dispatches to the agent. Fire-and-forget — errors land in onError.
        void debouncer.enqueue({
          model,
          res_id,
          body,
          message_id,
          user_name,
          partner_id,
        });

        return true;
      },
    });

    api.logger.info(`[odoo] Channel plugin loaded — webhook at ${webhookPath}`);
  },
});

export default entry;
