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
import { odooPlugin, resolveAccount, getClient } from "./channel.js";
import { setOdooRuntime, getOdooRuntime } from "./runtime.js";
import { createOdooSearchReadTool } from "./tools.js";

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

        api.logger.info(
          `[odoo] Inbound from ${user_name ?? "unknown"} on ${model},${res_id}`,
        );

        // ACK immediately
        res.statusCode = 202;
        res.end(JSON.stringify({ accepted: true, message_id }));

        // Dispatch to agent (async, after ACK)
        try {
          const rt = getOdooRuntime();
          const cfg = api.config;

          // Step 1: Resolve route — peer ID = "model:res_id" for 1-record-1-session
          const peerId = `${model}:${res_id}`;
          const route = rt.channel.routing.resolveAgentRoute({
            cfg,
            channel: "odoo",
            accountId: "default",
            peer: { kind: "direct", id: peerId },
          });

          // Step 2: Build and finalize inbound context
          const ctx = rt.channel.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: body,
            RawBody: body,
            CommandBody: body,
            From: `odoo:partner:${partner_id}`,
            To: `odoo:record:${peerId}`,
            SessionKey: route.sessionKey,
            AccountId: "default",
            ChatType: "direct",
            SenderId: String(partner_id),
            SenderName: user_name ?? "Odoo User",
            Provider: "odoo",
            Surface: "odoo",
            MessageSid: String(message_id),
            Timestamp: Date.now(),
            OriginatingChannel: "odoo",
            OriginatingTo: `odoo:record:${peerId}`,
            CommandAuthorized: false,
          });

          // Step 3: Record session
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

          // Step 4: Dispatch to agent — reply flows back through deliver()
          await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx,
            cfg,
            dispatcherOptions: {
              deliver: async (replyPayload: any) => {
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
                  requestMessageId: message_id,
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
          api.logger.error(`[odoo] Failed to dispatch inbound message: ${err}`);
        }

        return true;
      },
    });

    api.logger.info(`[odoo] Channel plugin loaded — webhook at ${webhookPath}`);
  },
});

export default entry;
