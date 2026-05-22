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
import { logMessageQueued } from "openclaw/plugin-sdk/text-runtime";
import { resolveOdooSection } from "./channel.js";
import { CHANNEL_ID, type InboundMessage, type PluginApi } from "./dispatch.js";
import type { InboxQueue } from "./inbox/queue.js";

type DedupeCache = ReturnType<typeof createDedupeCache>;
type Debouncer = { enqueue: (item: InboundMessage) => Promise<void> };

export function createWebhookHandler(deps: {
  api: PluginApi;
  dedupe: DedupeCache;
  debouncer: Debouncer;
  queue: InboxQueue;
  /**
   * Ready-gate. Returns false while boot recovery is still partitioning
   * the on-disk state. Handler returns 503 so Odoo retries instead of
   * dropping the message. Read per-request — the flag flips after the
   * handler factory has already been built.
   */
  isReady: () => boolean;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { api, dedupe, debouncer, queue, isReady } = deps;

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
    // Accept both `routingKey` (camelCase, our config-side convention) and
    // `routing_key` (snake_case, matches Odoo's controller style). Empty
    // strings normalize to undefined so they share the "no key" lane.
    const routingKeyRaw =
      typeof raw.routingKey === "string"
        ? raw.routingKey
        : typeof raw.routing_key === "string"
          ? raw.routing_key
          : undefined;
    const routing_key =
      routingKeyRaw !== undefined && routingKeyRaw.trim() !== ""
        ? routingKeyRaw
        : undefined;
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

    // Refuse new traffic while boot recovery is still partitioning disk
    // state. Recovery flips this true once it has scheduled every stale
    // batch. Odoo retries 5xx, so no message is dropped during the window.
    if (!isReady()) {
      return respond(503, { error: "Plugin starting — please retry" });
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

    // Persist BEFORE we ACK. The 202 we hand back to Odoo must mean
    // "this message is durably enqueued"; a disk failure here returns
    // 503 so Odoo retries instead of dropping the message silently.
    const result = await queue.appendOrCreateBatch({
      model,
      res_id,
      message_id,
      body,
      routing_key,
      user_name,
      partner_id,
    });

    if (!result.ok) {
      if (result.reason === "duplicate") {
        // Disk-level dedup — message_id is already in some on-disk
        // batch (active or failed). Memory cache missed (TTL expired or
        // process restarted) but disk is authoritative.
        api.logger.info(
          `[odoo] Disk-duplicate message_id ${message_id} on ${model},${res_id} ` +
            `(existing batch ${result.existingBatchKey}) — skipping`,
        );
        return respond(202, { accepted: true, duplicate: true });
      }
      // The in-memory dedup cache marked this message_id as seen during
      // the dedupe.check() call above (createDedupeCache.check() touches
      // the key on every call, not just hits). Roll back so Odoo's retry
      // isn't swallowed as a duplicate — otherwise this is silent loss.
      dedupe.delete(String(message_id));
      api.logger.error(
        `[odoo] queue.appendOrCreateBatch disk_error for ${model},${res_id} ` +
          `message_id=${message_id}: ${formatErr(result.error)}`,
      );
      return respond(503, { error: "Persist failure — please retry" });
    }

    api.logger.info(
      `[odoo] Inbound from ${user_name ?? "unknown"} on ${model},${res_id} ` +
        `batchKey=${result.batchKey} didCreate=${result.didCreate}`,
    );
    // Telemetry: gate on didCreate so appends to an existing batch don't
    // re-emit "queued" (would double-count batches as inbound).
    if (result.didCreate) {
      logMessageQueued({
        sessionKey: `${CHANNEL_ID}:${model}:${res_id}`,
        channel: CHANNEL_ID,
        source: "webhook",
      });
    }
    respond(202, { accepted: true, message_id, batchKey: result.batchKey });

    // Debouncer batches rapid messages to the same record; onFlush
    // dispatches to the agent. Fire-and-forget — errors land in onError.
    void debouncer.enqueue({
      model,
      res_id,
      body,
      message_id,
      routing_key,
      user_name,
      partner_id,
    });

    return true;
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
