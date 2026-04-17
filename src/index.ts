/**
 * OpenClaw channel plugin for Odoo.
 *
 * Inbound:  Odoo chatter module POSTs to /odoo/chatter (webhook)
 * Outbound: Agent replies via XML-RPC (openclaw_post_reply)
 *
 * @see https://github.com/mondaymerch/openclaw-channel-odoo
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { odooPlugin, resolveAccount } from "./channel.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry: any = defineChannelPluginEntry({
  id: "odoo",
  name: "Odoo",
  description: "Route AI conversations through Odoo chatter via XML-RPC",
  plugin: odooPlugin,

  registerFull(api) {
    const account = resolveAccount(api.config);
    const webhookPath = account.webhookPath;

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

        // TODO: dispatch to agent via runtime inbound pipeline
        // This requires wiring into the channel runtime's dispatchInboundDirectDmWithRuntime
        // or dispatchInboundMessageWithBufferedDispatcher once the runtime is set up.
        // For now, log the inbound message.
        api.logger.info(
          `[odoo] Message queued: ${model}:${res_id} from partner=${partner_id} msg_id=${message_id}`,
        );

        return true;
      },
    });

    api.logger.info(`[odoo] Channel plugin loaded — webhook at ${webhookPath}`);
  },
});

export default entry;
