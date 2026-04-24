/**
 * HTTP webhook handler — auth, body read/validate, dedup, ACK, enqueue.
 *
 * Errors thrown by the debounced dispatch flow land in the debouncer's
 * onError (not here), so this handler always responds synchronously.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createDedupeCache,
  readJsonBodyWithLimit,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
} from "openclaw/plugin-sdk/infra-runtime";
import { resolveOdooSection } from "./channel.js";
import type { InboundMessage, PluginApi } from "./dispatch.js";

type DedupeCache = ReturnType<typeof createDedupeCache>;
type Debouncer = { enqueue: (item: InboundMessage) => Promise<void> };

export function createWebhookHandler(deps: {
  api: PluginApi;
  dedupe: DedupeCache;
  debouncer: Debouncer;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { api, dedupe, debouncer } = deps;

  return async (req, res) => {
    const respond = (status: number, payload: object) => {
      res.statusCode = status;
      res.end(JSON.stringify(payload));
      return true;
    };

    // Re-read per request so hot-reloaded secrets take effect without restart.
    // resolveAccount enforces webhookSecret is set at config-load time, but we
    // re-check here because config can be hot-reloaded and we must never
    // accept an unauthenticated webhook.
    const secret = resolveOdooSection(api.config)?.webhookSecret;
    if (!secret) {
      api.logger.error("[odoo] webhookSecret missing from config — rejecting");
      return respond(503, { error: "Channel not configured" });
    }
    const authHeader = req.headers.authorization ?? "";
    if (authHeader !== `Bearer ${secret}`) {
      return respond(401, { error: "Unauthorized" });
    }

    const parsed = await readJsonBodyWithLimit(req, {
      maxBytes: DEFAULT_WEBHOOK_MAX_BODY_BYTES,
    });
    if (!parsed.ok) {
      const status =
        parsed.code === "PAYLOAD_TOO_LARGE" ? 413 :
        parsed.code === "REQUEST_BODY_TIMEOUT" ? 408 :
        400;
      return respond(status, { error: parsed.error });
    }

    const raw = parsed.value as Record<string, unknown>;
    const model = typeof raw.model === "string" ? raw.model : "";
    const res_id = Number(raw.res_id);
    const message_id = Number(raw.message_id);
    const body = typeof raw.body === "string" ? raw.body : "";
    const user_name =
      typeof raw.user_name === "string" ? raw.user_name : undefined;
    const partner_id =
      typeof raw.partner_id === "number" ? raw.partner_id : undefined;

    if (
      !model ||
      !Number.isInteger(res_id) || res_id <= 0 ||
      !body ||
      !Number.isInteger(message_id) || message_id <= 0
    ) {
      return respond(400, {
        error:
          "model (string), res_id (positive int), body (string), message_id (positive int) are required",
      });
    }

    // Dedup: drop webhook retries from Odoo's own controller retry logic.
    // Operator-initiated Retry (minutes later) will bypass this and
    // re-dispatch.
    if (dedupe.check(String(message_id))) {
      api.logger.info(
        `[odoo] Duplicate message_id ${message_id} on ${model},${res_id} — skipping`,
      );
      return respond(202, { accepted: true, duplicate: true });
    }

    api.logger.info(
      `[odoo] Inbound from ${user_name ?? "unknown"} on ${model},${res_id}`,
    );
    respond(202, { accepted: true, message_id });

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
  };
}
