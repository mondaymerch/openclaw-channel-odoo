/**
 * Odoo XML-RPC client for posting replies and reading records.
 *
 * Uses the standard Odoo external API (XML-RPC execute_kw).
 * Compatible with Odoo 12+ (XML-RPC interface is stable across versions).
 */

// @ts-ignore — xmlrpc has no type declarations
import xmlrpc from "xmlrpc";

export interface OdooConfig {
  url: string;
  db: string;
  uid: number;
  password: string;
}

export interface CallReplyParams {
  model: string;
  resId: number;
  body: string;
  requestMessageId: number;
  method: string;
  argNames: string[];
}

export class OdooClient {
  private config: OdooConfig;
  private objectClient: any;

  constructor(config: OdooConfig) {
    this.config = config;
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
   */
  private executeKw(
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {},
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.objectClient.methodCall(
        "execute_kw",
        [this.config.db, this.config.uid, this.config.password, model, method, args, kwargs],
        (err: Error | null, result: any) => {
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
   * Remaining args are built from argNames in order, mapped to available variables.
   *
   * Available variable names: body, requestMessageId, model, resId
   *
   * Default: openclaw_post_reply([resId], body, requestMessageId)
   */
  async callReply(params: CallReplyParams): Promise<any> {
    const { model, resId, method, argNames } = params;
    const argMap: Record<string, any> = {
      body: params.body,
      requestMessageId: params.requestMessageId,
      model: params.model,
      resId: params.resId,
    };
    const args = [[resId], ...argNames.map((name) => argMap[name])];
    return this.executeKw(model, method, args);
  }

  /**
   * Read record display name (for agent context).
   */
  async getRecordName(model: string, resId: number): Promise<string> {
    const records = await this.executeKw(model, "read", [[resId], ["display_name"]]);
    return records?.[0]?.display_name ?? `${model},${resId}`;
  }
}
