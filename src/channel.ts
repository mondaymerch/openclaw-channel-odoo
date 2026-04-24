/**
 * Odoo channel plugin definition.
 *
 * Handles:
 * - Config resolution (reads channels.odoo from openclaw.json)
 * - Route compilation (per-model method/agent dispatch)
 * - Security (allowlist-based DM policy)
 * - Outbound (agent replies → Odoo via XML-RPC)
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { OdooClient, type OdooConfig } from "./client.js";

export const CHANNEL_ID = "odoo";

// Variables available as references in route.reply.args / route.reply.kwargs.
// Kept in sync with the argMap built in client.callReply.
const KNOWN_VARIABLES = ["body", "requestMessageId", "model", "resId"] as const;
type KnownVariable = (typeof KNOWN_VARIABLES)[number];

export type KwargValue =
  | { kind: "ref"; name: KnownVariable }
  | { kind: "literal"; value: unknown };

type RouteMatch =
  | { kind: "catchall" }
  | { kind: "model"; regex: RegExp; pattern: string };

export type CompiledReply = {
  method: string;
  args: KnownVariable[];
  kwargs: Record<string, KwargValue>;
};

export type CompiledRoute = {
  match: RouteMatch;
  agentId?: string;
  reply: CompiledReply;
  source: string;
};

export interface ResolvedOdooAccount {
  accountId: string | null;
  url: string;
  db: string;
  uid: number;
  password: string;
  webhookSecret: string;
  webhookPath: string;
  allowFrom: string[];
  botSessionId: string | null;
  routes: CompiledRoute[];
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

export function resolveOdooSection(cfg: OpenClawConfig): Record<string, any> | undefined {
  return (cfg.channels as Record<string, any>)?.["odoo"];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileModelGlob(pattern: string): RegExp {
  // Split on "*" so each segment can be escaped independently; rejoin with ".*"
  const source = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${source}$`);
}

function isKnownVariable(name: string): name is KnownVariable {
  return (KNOWN_VARIABLES as readonly string[]).includes(name);
}

function compileKwargs(
  raw: unknown,
  routePath: string,
): Record<string, KwargValue> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`odoo: ${routePath}.reply.kwargs: must be an object`);
  }
  const out: Record<string, KwargValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (value.startsWith("$$")) {
        out[key] = { kind: "literal", value: value.slice(1) };
      } else if (value.startsWith("$")) {
        const name = value.slice(1);
        if (!isKnownVariable(name)) {
          throw new Error(
            `odoo: ${routePath}.reply.kwargs.${key}: unknown variable "$${name}" (known: ${KNOWN_VARIABLES.join(", ")})`,
          );
        }
        out[key] = { kind: "ref", name };
      } else {
        out[key] = { kind: "literal", value };
      }
    } else {
      // number / boolean / array / object / null — passed through as-is
      out[key] = { kind: "literal", value };
    }
  }
  return out;
}

function compileReply(raw: unknown, routePath: string): CompiledReply {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`odoo: ${routePath}.reply: must be an object`);
  }
  const { method, args, kwargs } = raw as Record<string, unknown>;

  if (typeof method !== "string" || !method.trim()) {
    throw new Error(`odoo: ${routePath}.reply.method: required non-empty string`);
  }

  const compiledArgs: KnownVariable[] = [];
  if (args !== undefined) {
    if (!Array.isArray(args)) {
      throw new Error(`odoo: ${routePath}.reply.args: must be an array of variable names`);
    }
    args.forEach((name, i) => {
      if (typeof name !== "string" || !isKnownVariable(name)) {
        throw new Error(
          `odoo: ${routePath}.reply.args[${i}]: unknown variable "${String(name)}" (known: ${KNOWN_VARIABLES.join(", ")})`,
        );
      }
      compiledArgs.push(name);
    });
  }

  const compiledKwargs = compileKwargs(kwargs, routePath);

  return { method, args: compiledArgs, kwargs: compiledKwargs };
}

function compileMatch(raw: unknown, routePath: string): RouteMatch {
  if (raw === "*") return { kind: "catchall" };
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const { model } = raw as Record<string, unknown>;
    if (typeof model !== "string" || !model.trim()) {
      throw new Error(`odoo: ${routePath}.match.model: required non-empty string`);
    }
    return { kind: "model", regex: compileModelGlob(model), pattern: model };
  }
  throw new Error(`odoo: ${routePath}.match: must be "*" or { model: "<glob>" }`);
}

export function compileRoutes(raw: unknown): CompiledRoute[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("odoo: routes: required non-empty array in channels.odoo");
  }
  const out: CompiledRoute[] = [];
  raw.forEach((entry, i) => {
    const routePath = `routes[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`odoo: ${routePath}: must be an object`);
    }
    const { match, agentId, reply } = entry as Record<string, unknown>;

    let agent: string | undefined;
    if (agentId !== undefined) {
      if (typeof agentId !== "string" || !agentId.trim()) {
        throw new Error(`odoo: ${routePath}.agentId: must be a non-empty string when present`);
      }
      agent = agentId;
    }

    out.push({
      match: compileMatch(match, routePath),
      agentId: agent,
      reply: compileReply(reply, routePath),
      source: routePath,
    });
  });

  const last = out[out.length - 1];
  if (last.match.kind !== "catchall") {
    throw new Error(
      `odoo: routes: last entry must be { match: "*" } (catchall) — got ${last.source}`,
    );
  }

  return out;
}

export function findRouteForModel(
  routes: CompiledRoute[],
  model: string,
): CompiledRoute {
  for (const route of routes) {
    if (route.match.kind === "catchall") return route;
    if (route.match.regex.test(model)) return route;
  }
  // Unreachable: compileRoutes guarantees a catchall at the end.
  throw new Error(`odoo: no route matched model "${model}"`);
}

// Accepts either "model:resId" (bare) or "odoo:record:model:resId" (with
// prefix). `model` may contain dots (e.g. "sale.order.line") but no colons,
// so we split on the last colon rather than `split(":")`.
export function parseRecordAddress(
  s: string,
): { model: string; resId: number } | null {
  if (!s) return null;
  const prefix = `${CHANNEL_ID}:record:`;
  const body = s.startsWith(prefix) ? s.slice(prefix.length) : s;
  const lastColon = body.lastIndexOf(":");
  if (lastColon < 0) return null;
  const model = body.slice(0, lastColon);
  const resId = Number.parseInt(body.slice(lastColon + 1), 10);
  if (!model || !Number.isInteger(resId) || resId <= 0) return null;
  return { model, resId };
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
  if (!section?.webhookSecret) {
    throw new Error("odoo: webhookSecret is required in channels.odoo");
  }
  if (section.replyMethod !== undefined || section.replyArgs !== undefined) {
    throw new Error(
      "odoo: replyMethod/replyArgs are removed — configure channels.odoo.routes instead (see README)",
    );
  }

  const routes = compileRoutes(section.routes);

  return {
    accountId: _accountId ?? null,
    url: section.url,
    db: section.db,
    uid: section.uid,
    password: section.password,
    webhookSecret: section.webhookSecret,
    webhookPath: section.webhookPath,
    allowFrom: section.allowFrom ?? [],
    botSessionId: section.botSessionId ?? null,
    routes,
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
      status: {
        // Webhook-based channel — no persistent socket to monitor
        skipStaleSocketHealthCheck: true,
      },
      gateway: {
        // Webhook-based channel has no runtime lifecycle of its own. Without a
        // startAccount, the channel never enters "running" state, so the gateway
        // health monitor keeps restarting it every 60s with reason "stopped".
        // A trivial passive monitor keeps `running: true` until shutdown.
        startAccount: async (ctx: { abortSignal: AbortSignal }) => {
          await runStoppablePassiveMonitor({
            abortSignal: ctx.abortSignal,
            start: async () => ({ stop: () => {} }),
          });
        },
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

        const target = String(ctx.threadId ?? ctx.to ?? "");
        const parsed = parseRecordAddress(target);
        if (!parsed) {
          throw new Error(
            `odoo: invalid thread target "${target}" — expected "model:resId" or "odoo:record:model:resId"`,
          );
        }
        const { model, resId } = parsed;

        const route = findRouteForModel(account.routes, model);

        // requestMessageId comes from the inbound context (ReplyToId), set in
        // dispatch.ts when the batch is dispatched.
        const requestMessageId = ctx.replyToId ? parseInt(ctx.replyToId, 10) : 0;

        const replyId = await client.callReply({
          model,
          resId,
          body: ctx.text,
          requestMessageId,
          method: route.reply.method,
          argNames: route.reply.args,
          kwargs: route.reply.kwargs,
          botSessionId: account.botSessionId,
        });

        return { messageId: String(replyId) };
      },
    },
  },
});

export { getClient };
