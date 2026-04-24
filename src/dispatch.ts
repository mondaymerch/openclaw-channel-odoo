/**
 * dispatchBatch — the 5-step route → ctx → session → dispatch → deliver
 * pipeline that hands a batch of inbound Odoo messages to the agent and
 * posts the reply back via XML-RPC.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  buildAgentSessionKey,
  buildAgentMainSessionKey,
  deriveLastRoutePolicy,
  sanitizeAgentId,
} from "openclaw/plugin-sdk/routing";
import {
  findRouteForModel,
  getClient,
  type ResolvedOdooAccount,
} from "./channel.js";
import type { OdooConfig } from "./client.js";
import { getOdooRuntime } from "./runtime.js";

export const CHANNEL_ID = "odoo";
export const ACCOUNT_ID = "default";

export type InboundMessage = {
  model: string;
  res_id: number;
  body: string;
  message_id: number;
  user_name?: string;
  partner_id?: number;
};

// Minimal structural type — only the fields dispatchBatch and the handler
// actually use. The SDK's real api type is `any` at the callsite.
export type PluginApi = {
  config: OpenClawConfig;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
};

export function createDispatchBatch(deps: {
  api: PluginApi;
  account: ResolvedOdooAccount;
  clientConfig: OdooConfig;
}): (items: InboundMessage[]) => Promise<void> {
  const { api, account, clientConfig } = deps;

  return async (items) => {
    if (items.length === 0) return;
    const last = items[items.length - 1];
    const { model, res_id } = last;
    const peerId = `${model}:${res_id}`;
    const combinedBody = items.map((i) => i.body).join("\n\n");
    const messageIds = items.map((i) => String(i.message_id));

    try {
      const rt = getOdooRuntime();
      const cfg = api.config;

      const matched = findRouteForModel(account.routes, model);

      let route = rt.channel.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL_ID,
        accountId: ACCOUNT_ID,
        peer: { kind: "direct", id: peerId },
      });

      // Per-route agentId override — mirrors the Telegram topic-agent pattern
      // (see telegram bot-Ch7__EHu.js:663-689). We rebuild the sessionKey from
      // the override agent so downstream session records are scoped correctly.
      if (matched.agentId) {
        const agentId = sanitizeAgentId(matched.agentId);
        const sessionKey = buildAgentSessionKey({
          agentId,
          channel: CHANNEL_ID,
          accountId: ACCOUNT_ID,
          peer: { kind: "direct", id: peerId },
          dmScope: cfg.session?.dmScope,
          identityLinks: cfg.session?.identityLinks,
        });
        const mainSessionKey = buildAgentMainSessionKey({ agentId });
        route = {
          ...route,
          agentId,
          sessionKey,
          mainSessionKey,
          lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
        };
      }

      const recordAddress = `${CHANNEL_ID}:record:${peerId}`;

      const ctx = rt.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        BodyForAgent: combinedBody,
        RawBody: combinedBody,
        CommandBody: combinedBody,
        From: `${CHANNEL_ID}:partner:${last.partner_id}`,
        To: recordAddress,
        SessionKey: route.sessionKey,
        AccountId: ACCOUNT_ID,
        ChatType: "direct",
        SenderId: String(last.partner_id),
        SenderName: last.user_name ?? "Odoo User",
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        MessageSid: String(last.message_id),
        MessageSids: messageIds,
        MessageSidFirst: messageIds[0],
        MessageSidLast: messageIds[messageIds.length - 1],
        // Carries the triggering message_id through to
        // attachedResults.sendText (→ ctx.replyToId), which passes it as
        // requestMessageId in the XML-RPC callback. Without this, Odoo's
        // openclaw_post_reply receives 0, skips the tracking flip and bus
        // notification, and the user's panel never refreshes.
        ReplyToId: String(last.message_id),
        Timestamp: Date.now(),
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: recordAddress,
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
          channel: CHANNEL_ID,
          to: recordAddress,
          accountId: ACCOUNT_ID,
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

            await getClient(clientConfig).callReply({
              model,
              resId: res_id,
              body: text,
              requestMessageId: last.message_id,
              method: matched.reply.method,
              argNames: matched.reply.args,
              kwargs: matched.reply.kwargs,
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
}
