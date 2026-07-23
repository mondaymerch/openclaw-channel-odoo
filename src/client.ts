/**
 * Odoo XML-RPC client for posting replies and reading records.
 *
 * Uses the standard Odoo external API (XML-RPC execute_kw).
 * Compatible with Odoo 12+ (XML-RPC interface is stable across versions).
 */

// @ts-ignore — xmlrpc has no type declarations
import xmlrpc from "xmlrpc";

import type { KwargValue } from "./channel.js";

export interface OdooConfig {
  url: string;
  db: string;
  uid: number;
  password: string;
  /**
   * Per-RPC timeout in ms for a single execute_kw call. A hung Odoo call
   * rejects with {@link RpcTimeoutError} after this many ms instead of hanging
   * the operation until the channel-level dispatch timeout. Defaults to
   * {@link DEFAULT_RPC_TIMEOUT_MS} (120s). Resolved from
   * `channels.odoo.rpcTimeoutMs`.
   */
  rpcTimeoutMs?: number;
}

/** Default per-RPC timeout (120s) when `channels.odoo.rpcTimeoutMs` is unset. */
export const DEFAULT_RPC_TIMEOUT_MS = 120_000;

/**
 * Raised when a single execute_kw call exceeds the per-RPC timeout. Carries a
 * stable `code` ("rpc_timeout") so callers (the odoo_quote_rpc bridge) can map
 * it to a distinct per-op error code rather than the generic execution failure.
 *
 * A timeout means the write may or may not have landed on the Odoo side — the
 * transport simply stopped waiting for the reply.
 */
export class RpcTimeoutError extends Error {
  readonly code = "rpc_timeout";
  constructor(
    readonly model: string,
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(
      `odoo: XML-RPC ${model}.${method} timed out after ${timeoutMs}ms ` +
        "(the write may or may not have landed)",
    );
    this.name = "RpcTimeoutError";
  }
}

export interface CallReplyParams {
  model: string;
  resId: number;
  body: string;
  requestMessageId: number;
  /** Optional routing key from the inbound webhook. Available as
   *  `$routingKey` in route reply args/kwargs. */
  routingKey?: string | null;
  method: string;
  argNames: string[];
  kwargs?: Record<string, KwargValue>;
  botSessionId?: string | null;
}

export class OdooClient {
  private config: OdooConfig;
  private objectClient: any;
  private rpcTimeoutMs: number;

  constructor(config: OdooConfig) {
    this.config = config;
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const parsed = new URL(config.url);
    const isSecure = parsed.protocol === "https:";
    const port = parsed.port
      ? parseInt(parsed.port)
      : isSecure
        ? 443
        : 80;

    const clientOptions = {
      host: parsed.hostname,
      port,
      path: "/xmlrpc/2/object",
    };

    this.objectClient = isSecure
      ? xmlrpc.createSecureClient(clientOptions)
      : xmlrpc.createClient(clientOptions);
  }

  /**
   * Call an Odoo model method via XML-RPC execute_kw.
   *
   * Bounded by a per-RPC timeout ({@link rpcTimeoutMs}): if the underlying
   * XML-RPC call has not settled by then, the promise rejects with an
   * {@link RpcTimeoutError} so a hung Odoo call can't stall the operation until
   * the far larger channel-level dispatch timeout. A late callback arriving
   * after the timeout is ignored (single-settle guard). No retry/backoff is
   * added here — idempotency is the caller's concern (e.g. the bridge's
   * client_ref).
   */
  private executeKw(
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {},
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new RpcTimeoutError(model, method, this.rpcTimeoutMs));
      }, this.rpcTimeoutMs);

      this.objectClient.methodCall(
        "execute_kw",
        [this.config.db, this.config.uid, this.config.password, model, method, args, kwargs],
        (err: Error | null, result: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(result);
        },
      );
    });
  }

  /**
   * Call a configurable reply method on an Odoo record.
   *
   * The first positional arg is always [resId] (Odoo convention).
   * Remaining positional args are built from argNames (each resolved against
   * argMap). kwargs entries are resolved per KwargValue (ref → argMap lookup,
   * literal → passed through as-is).
   *
   * Available variable names: body, requestMessageId, model, resId, routingKey
   * (routingKey is `null` when the inbound webhook didn't supply one).
   */
  async callReply(params: CallReplyParams): Promise<any> {
    const { model, resId, method, argNames } = params;
    const argMap: Record<string, any> = {
      body: params.body,
      requestMessageId: params.requestMessageId,
      model: params.model,
      resId: params.resId,
      routingKey: params.routingKey ?? null,
    };

    const resolveVar = (name: string): any => {
      if (!(name in argMap)) {
        throw new Error(`odoo: unknown variable "${name}" at call time`);
      }
      return argMap[name];
    };

    const args = [[resId], ...argNames.map(resolveVar)];

    const kwargs: Record<string, any> = {};
    for (const [key, spec] of Object.entries(params.kwargs ?? {})) {
      kwargs[key] = spec.kind === "ref" ? resolveVar(spec.name) : spec.value;
    }

    if (params.botSessionId) {
      // Merge bot_session_id into context without clobbering a user-supplied
      // context object — user keys stay, we add our one field.
      const existingContext =
        kwargs.context && typeof kwargs.context === "object" && !Array.isArray(kwargs.context)
          ? (kwargs.context as Record<string, any>)
          : {};
      kwargs.context = { ...existingContext, bot_session_id: params.botSessionId };
    }

    return this.executeKw(model, method, args, kwargs);
  }

  /**
   * Search and read records from any Odoo model.
   *
   * This wraps the standard ORM `search_read` method, available on
   * every model since Odoo 8. Used by the agent tool to fetch
   * conversation history, record details, linked records, etc.
   */
  async searchRead(params: {
    model: string;
    domain: any[];
    fields?: string[];
    limit?: number;
    order?: string;
    botSessionId?: string | null;
  }): Promise<any[]> {
    const kwargs: Record<string, any> = {
      fields: params.fields ?? [],
      limit: params.limit ?? 20,
      order: params.order ?? "id desc",
    };
    if (params.botSessionId) {
      kwargs.context = { bot_session_id: params.botSessionId };
    }
    return this.executeKw(params.model, "search_read", [params.domain], kwargs);
  }

  /**
   * Call an arbitrary model method via XML-RPC execute_kw.
   *
   * Generic transport used by the product-creation agent tools: they call
   * `agent.api` service methods (e.g. spawn_customer_product) whose single
   * positional argument is the payload dict, and return the method's response
   * envelope verbatim. `botSessionId` is merged into the call context the same
   * way `callReply` does it — added to any caller-supplied context object
   * without clobbering it (unlike `searchRead`, which overwrites context
   * wholesale; here we preserve caller keys).
   *
   * Named `callMethod` rather than reusing the private `executeKw` name to
   * avoid shadowing the raw transport while adding the context-injection layer.
   */
  async callMethod(params: {
    model: string;
    method: string;
    args: any[];
    kwargs?: Record<string, any>;
    botSessionId?: string | null;
  }): Promise<any> {
    const kwargs: Record<string, any> = { ...(params.kwargs ?? {}) };
    if (params.botSessionId) {
      const existingContext =
        kwargs.context && typeof kwargs.context === "object" && !Array.isArray(kwargs.context)
          ? (kwargs.context as Record<string, any>)
          : {};
      kwargs.context = { ...existingContext, bot_session_id: params.botSessionId };
    }
    return this.executeKw(params.model, params.method, params.args, kwargs);
  }

  /**
   * Read record display name (for agent context).
   */
  async getRecordName(model: string, resId: number): Promise<string> {
    const records = await this.executeKw(model, "read", [[resId], ["display_name"]]);
    return records?.[0]?.display_name ?? `${model},${resId}`;
  }
}
