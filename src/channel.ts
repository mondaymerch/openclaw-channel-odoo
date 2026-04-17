/**
 * Odoo channel plugin definition.
 *
 * Handles:
 * - Config resolution (reads channels.odoo from openclaw.json)
 * - Security (allowlist-based DM policy)
 * - Outbound (agent replies → Odoo via XML-RPC)
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { OdooClient, type OdooConfig } from "./client.js";

export interface ResolvedOdooAccount {
  accountId: string | null;
  url: string;
  db: string;
  uid: number;
  password: string;
  webhookSecret: string;
  webhookPath: string;
  allowFrom: string[];
  replyMethod: string;
  replyArgs: string[];
}

// Per-account client cache
const clients = new Map<string, OdooClient>();

function getClient(config: OdooConfig): OdooClient {
  const key = `${config.url}:${config.db}:${config.uid}`;
  let client = clients.get(key);
  if (!client) {
    client = new OdooClient(config);
    clients.set(key, client);
  }
  return client;
}

function resolveOdooSection(cfg: OpenClawConfig): Record<string, any> | undefined {
  return (cfg.channels as Record<string, any>)?.["odoo"];
}

export function resolveAccount(
  cfg: OpenClawConfig,
  _accountId?: string | null,
): ResolvedOdooAccount {
  const section = resolveOdooSection(cfg);
  if (!section?.url || !section?.db || !section?.uid || !section?.password) {
    throw new Error("odoo: url, db, uid, and password are required in channels.odoo");
  }
  if (!section?.webhookPath) {
    throw new Error("odoo: webhookPath is required in channels.odoo");
  }
  if (!section?.replyMethod || !section?.replyArgs) {
    throw new Error("odoo: replyMethod and replyArgs are required in channels.odoo");
  }
  return {
    accountId: _accountId ?? null,
    url: section.url,
    db: section.db,
    uid: section.uid,
    password: section.password,
    webhookSecret: section.webhookSecret ?? "",
    webhookPath: section.webhookPath,
    allowFrom: section.allowFrom ?? [],
    replyMethod: section.replyMethod,
    replyArgs: section.replyArgs,
  };
}

export const odooPlugin = createChatChannelPlugin<ResolvedOdooAccount>({
  base: Object.assign(
    createChannelPluginBase<ResolvedOdooAccount>({
      id: "odoo",
      capabilities: {
        chatTypes: ["direct"],
      },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount,
      },
      setup: {
        applyAccountConfig: ({ cfg }) => cfg,
      },
    }),
    {
      config: {
        listAccountIds: () => ["default"],
        resolveAccount,
      } as const,
      capabilities: {
        chatTypes: ["direct" as const],
      },
    },
  ),

  security: {
    dm: {
      channelKey: "odoo",
      resolvePolicy: () => "allowlist",
      resolveAllowFrom: (account: ResolvedOdooAccount) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  threading: {
    topLevelReplyToMode: "reply",
  },

  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: "odoo",
      sendText: async (ctx) => {
        const account = resolveAccount(ctx.cfg);
        const client = getClient({
          url: account.url,
          db: account.db,
          uid: account.uid,
          password: account.password,
        });

        // threadId encodes "model:resId" (e.g. "crm.lead:1234")
        const threadId = String(ctx.threadId ?? ctx.to ?? "");
        const [model, resIdStr] = threadId.split(":");
        const resId = parseInt(resIdStr, 10);

        if (!model || !resId) {
          throw new Error(`odoo: invalid thread target "${threadId}" — expected "model:resId"`);
        }

        // requestMessageId passed via replyToId from inbound metadata
        const requestMessageId = ctx.replyToId ? parseInt(ctx.replyToId, 10) : 0;

        const replyId = await client.callReply({
          model,
          resId,
          body: ctx.text,
          requestMessageId,
          method: account.replyMethod,
          argNames: account.replyArgs,
        });

        return { messageId: String(replyId) };
      },
    },
  },
});

export { getClient };
