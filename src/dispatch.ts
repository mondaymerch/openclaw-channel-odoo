/**
 * Dispatch handler — the route → ctx → session → dispatch → deliver
 * pipeline that hands a persisted batch of inbound Odoo messages to the
 * agent and posts the reply back via XML-RPC.
 *
 * Exposed via `createDispatchHandler(...)`'s `processBatch` method, which
 * is the SINGLE entry point for batch handling in this plugin. Called by:
 *   - the debouncer's onFlush adapter (after first webhook in a batch)
 *   - the scheduler's retry timer (after a classified failure)
 *   - boot recovery (indirectly, via scheduler.scheduleAt)
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { logMessageProcessed } from "openclaw/plugin-sdk/text-runtime";
import {
  buildAgentSessionKey,
  buildAgentMainSessionKey,
  deriveLastRoutePolicy,
  sanitizeAgentId,
} from "openclaw/plugin-sdk/routing";
import {
  findRouteForInbound,
  getClient,
  type CompiledRoute,
  type ResolvedOdooAccount,
} from "./channel.js";
import type { CallReplyParams, OdooConfig } from "./client.js";
import type { BatchRef, InboxQueue } from "./inbox/queue.js";
import type { RetryScheduler } from "./inbox/scheduler.js";
import { HARD_TIMEOUT_MS, type InboxBatch } from "./inbox/types.js";
import { getOdooRuntime } from "./runtime.js";

export const CHANNEL_ID = "odoo";
export const ACCOUNT_ID = "default";

export type InboundMessage = {
  model: string;
  res_id: number;
  body: string;
  message_id: number;
  /** Optional opaque tag for sub-model routing. Routes can match on this
   *  with `{ routingKey: "<glob>" }`. Two messages on the same record with
   *  different routing keys land in independent batches. */
  routing_key?: string;
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

/**
 * Build a single-line header that gets prepended to BodyForAgent so the
 * agent can deterministically detect it's on the Odoo channel and pull the
 * record reference + sender info without an extra tool call.
 *
 * Only added when the matched route has promptHeader=true (default).
 */
function formatChannelHeader(params: {
  model: string;
  resId: number;
  routingKey?: string | null;
  userName?: string;
  partnerId?: number;
}): string {
  const parts = [
    `[${CHANNEL_ID}]`,
    `model=${params.model}`,
    `res_id=${params.resId}`,
  ];
  const trimmedKey =
    typeof params.routingKey === "string" ? params.routingKey.trim() : "";
  if (trimmedKey) {
    const escaped = trimmedKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    parts.push(`routing_key="${escaped}"`);
  }
  const trimmedName = params.userName?.trim();
  if (trimmedName) {
    const escaped = trimmedName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    parts.push(`user="${escaped}"`);
  }
  if (params.partnerId !== undefined && Number.isInteger(params.partnerId)) {
    parts.push(`partner_id=${params.partnerId}`);
  }
  return parts.join(" ");
}

export type DispatchHandler = {
  /**
   * Process a single batch. The ONLY batch-handler in the system.
   *
   * Branches on `batch.state`:
   *  - "received"     → full dispatch (agent run + deliver wrap)
   *  - "reply_ready"  → skip the agent, re-fire XML-RPC with the saved text
   *
   * Does not throw to the caller for classified failures (silent /
   * internal_error / xmlrpc_failure) — those are reported via
   * `scheduler.handleFailure`.
   */
  processBatch(batch: InboxBatch): Promise<void>;
};

export type CreateDispatchHandlerDeps = {
  api: PluginApi;
  account: ResolvedOdooAccount;
  clientConfig: OdooConfig;
  queue: InboxQueue;
  scheduler: RetryScheduler;
  /** Hard timeout for the dispatch await. Default: `HARD_TIMEOUT_MS` (15min). */
  hardTimeoutMs?: number;
  /**
   * Test seam — default uses `channel.ts`'s real `getClient`. Tests inject
   * a fake to avoid spinning up an XML-RPC client.
   */
  getClient?: (cfg: OdooConfig) => { callReply: (p: CallReplyParams) => Promise<unknown> };
};

export function createDispatchHandler(deps: CreateDispatchHandlerDeps): DispatchHandler {
  const { api, account, clientConfig, queue, scheduler } = deps;
  const hardTimeoutMs = deps.hardTimeoutMs ?? HARD_TIMEOUT_MS;
  const getOdooClient = deps.getClient ?? getClient;

  return {
    async processBatch(batch: InboxBatch): Promise<void> {
      const ref: BatchRef = {
        model: batch.model,
        res_id: batch.res_id,
        batchKey: batch.batchKey,
        routing_key: batch.routing_key,
      };

      let matched: CompiledRoute;
      try {
        matched = findRouteForInbound(account.routes, {
          model: batch.model,
          routingKey: batch.routing_key,
        });
      } catch (err) {
        // findRouteForInbound throws when no route matches AND no catchall
        // exists. `compileRoutes` adds a catchall at the end, so in
        // production this can't fire — but defensive against misconfig.
        api.logger.error(
          `[odoo] processBatch: no route for model=${batch.model} routingKey=${batch.routing_key ?? ""} batchKey=${batch.batchKey}`,
        );
        await scheduler.handleFailure(ref, "internal_error", err);
        return;
      }

      // ---- Branch on batch.state --------------------------------------
      switch (batch.state) {
        case "reply_ready": {
          // Branch 1: agent already produced the text on a prior attempt;
          // just re-fire XML-RPC. Don't re-run the agent.
          if (!batch.reply) {
            api.logger.error(
              `[odoo] reply_ready batch without reply.text batchKey=${batch.batchKey}`,
            );
            await scheduler.handleFailure(
              ref,
              "internal_error",
              new Error("reply_ready without reply.text"),
            );
            return;
          }
          try {
            await postViaCallReply(getOdooClient, matched, account, clientConfig, batch, batch.reply.text);
            await queue.recordDeliverySuccess(ref);
            logMessageProcessed({
              channel: CHANNEL_ID,
              sessionKey: `${CHANNEL_ID}:${batch.model}:${batch.res_id}`,
              chatId: `${batch.model},${batch.res_id}`,
              outcome: "completed",
              durationMs: Date.now() - batch.enqueuedAt,
            });
          } catch (err) {
            await scheduler.handleFailure(ref, "xmlrpc_failure", err);
          }
          return;
        }
        case "dispatching": {
          // Shouldn't reach here — scheduler and boot recovery never
          // schedule a "dispatching" batch directly (recovery normalizes
          // stale dispatching to "received" first; live dispatching means
          // some other caller is already mid-flight). Defensive skip.
          api.logger.error(
            `[odoo] processBatch unexpected state=dispatching batchKey=${batch.batchKey} — skipping`,
          );
          return;
        }
        case "received":
          break; // fall through to Branch 2 below
        default: {
          const _exhaustive: never = batch.state;
          api.logger.error(
            `[odoo] processBatch unknown state batchKey=${batch.batchKey}: ${String(_exhaustive)}`,
          );
          return;
        }
      }

      // ---- Branch 2: received — full dispatch -------------------------
      // CAS transition received → dispatching. If we lose (another caller
      // is already dispatching this batchKey, or the file vanished), skip.
      const markResult = await queue.markDispatching(ref);
      if (!markResult.ok) {
        api.logger.info(
          `[odoo] processBatch skipping dispatch batchKey=${batch.batchKey} reason=${markResult.reason}`,
        );
        return;
      }
      // Tracks what the deliver wrapper observed. null = deliver never
      // fired successfully (silent agent, or post-await we'll classify).
      let deliverOutcome: "success" | "xmlrpc_failure" | null = null;

      try {
        const rt = getOdooRuntime();
        const cfg = api.config;
        const last = batch.messages[batch.messages.length - 1];
        const peerId = `${batch.model}:${batch.res_id}`;
        const combinedBody = batch.messages.map((m) => m.body).join("\n\n");
        const messageIds = batch.messages.map((m) => String(m.message_id));

        // --- Route resolution + per-route agentId override.
        let route = rt.channel.routing.resolveAgentRoute({
          cfg,
          channel: CHANNEL_ID,
          accountId: ACCOUNT_ID,
          peer: { kind: "direct", id: peerId },
        });
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
        const bodyForAgent = matched.promptHeader
          ? `${formatChannelHeader({
              model: batch.model,
              resId: batch.res_id,
              routingKey: batch.routing_key,
              userName: last.user_name,
              partnerId: last.partner_id,
            })}\n\n${combinedBody}`
          : combinedBody;

        const ctx = rt.channel.reply.finalizeInboundContext({
          Body: combinedBody,
          BodyForAgent: bodyForAgent,
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

        // --- Race: openclaw dispatch vs hard timeout
        const dispatchPromise = rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          cfg,
          dispatcherOptions: {
            deliver: async (replyPayload: { text?: string }) => {
              const text = replyPayload?.text;
              if (!text) return;
              api.logger.info(
                `[odoo] Delivering reply to ${batch.model},${batch.res_id}`,
              );
              await queue.transitionToReplyReady(ref, text);
              try {
                await postViaCallReply(getOdooClient, matched, account, clientConfig, batch, text);
                await queue.recordDeliverySuccess(ref);
                logMessageProcessed({
                  channel: CHANNEL_ID,
                  sessionKey: `${CHANNEL_ID}:${batch.model}:${batch.res_id}`,
                  chatId: `${batch.model},${batch.res_id}`,
                  outcome: "completed",
                  durationMs: Date.now() - batch.enqueuedAt,
                });
                deliverOutcome = "success";
              } catch (xmlErr) {
                await scheduler.handleFailure(ref, "xmlrpc_failure", xmlErr);
                deliverOutcome = "xmlrpc_failure";
                // Do NOT rethrow — we've handled it. Rethrowing would just
                // cascade to the outer catch which would re-classify as
                // internal_error and double-bump counters.
              }
            },
            onError: (err: unknown) => {
              api.logger.error(`[odoo] Reply dispatch error: ${err}`);
            },
          },
        });

        const result = await Promise.race<{ kind: "resolved" } | { kind: "timeout" }>([
          dispatchPromise.then(() => ({ kind: "resolved" as const })),
          new Promise<{ kind: "timeout" }>((resolve) => {
            const t = setTimeout(() => resolve({ kind: "timeout" }), hardTimeoutMs);
            if (t && typeof (t as { unref?: () => void }).unref === "function") {
              (t as { unref: () => void }).unref();
            }
          }),
        ]);

        if (result.kind === "timeout" && deliverOutcome === null) {
          await scheduler.handleFailure(
            ref,
            "internal_error",
            new Error("dispatch hard timeout"),
          );
          // The original dispatch promise still runs in background. Its
          // eventual deliver (if any) hits the re-read-before-fire pattern
          // — batch may already be unlinked or re-dispatched by then.
        } else if (result.kind === "resolved" && deliverOutcome === null) {
          // Dispatch resolved cleanly but no successful deliver fired →
          // agent silent (no final reply produced).
          await scheduler.handleFailure(
            ref,
            "silent",
            new Error("dispatch resolved without successful deliver"),
          );
        }
      } catch (err) {
        if (deliverOutcome === null) {
          await scheduler.handleFailure(ref, "internal_error", err);
        }
      }
    },
  };
}

/** XML-RPC call shared by both branches. Reuses the matched route's reply
 *  config (method + arg names + kwargs) and the account's botSessionId. */
async function postViaCallReply(
  getClientFn: (cfg: OdooConfig) => { callReply: (p: CallReplyParams) => Promise<unknown> },
  matched: CompiledRoute,
  account: ResolvedOdooAccount,
  clientConfig: OdooConfig,
  batch: InboxBatch,
  text: string,
): Promise<void> {
  const last = batch.messages[batch.messages.length - 1];
  await getClientFn(clientConfig).callReply({
    model: batch.model,
    resId: batch.res_id,
    body: text,
    requestMessageId: last.message_id,
    routingKey: batch.routing_key,
    method: matched.reply.method,
    argNames: matched.reply.args,
    kwargs: matched.reply.kwargs,
    botSessionId: account.botSessionId,
  });
}
