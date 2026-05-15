# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor bumps may contain breaking changes).

## [Unreleased]

### Added

- **OTEL telemetry via openclaw diagnostic events.** Three conceptual events emitted at lifecycle transitions: `message.queued` on persist, `message.processed{outcome}` on terminal state (completed or error), and `run.attempt` + structured `inbox.failure` log per failure. Auto-collected by `@openclaw/otel-diagnostics` (no plugin-side OTLP wiring).

  Five emission sites:
  - `webhook-handler.ts` — `logMessageQueued` after a new batch is persisted (gated on `didCreate=true` so batch appends don't double-count).
  - `dispatch.ts` ×2 — `logMessageProcessed{outcome="completed", durationMs}` after each `recordDeliverySuccess` (reply_ready re-delivery + main success path).
  - `scheduler.ts` (`handleFailure`) — `logRunAttempt` + `diagnosticLogger.info("inbox.failure", …)` on every recorded failure, then `logMessageProcessed{outcome="error", reason="cap_exhausted:<class>", durationMs}` if the cap is hit.
  - `recovery.ts` — `logMessageProcessed{outcome="error", reason="ttl_expired", durationMs}` for batches moved to `failed/` because their TTL elapsed before delivery.

  What flows to the OTEL backend (via `@openclaw/otel-diagnostics`):
  - **Counters:** `openclaw.message.queued{channel,source}`, `openclaw.message.processed{channel,outcome}`, `openclaw.run.attempt{attempt}`.
  - **Histogram:** `openclaw.message.duration_ms` (end-to-end webhook→delivery latency).
  - **Span attributes** on `openclaw.message.processed` spans: `openclaw.sessionKey`, `openclaw.chatId`, `openclaw.reason` (failure class). Per-class slicing of errors is queryable in tracing backends (TraceQL/Jaeger), not in Prometheus.
  - **Structured OTLP log:** `inbox.failure` with `failureClass`, `dispatchAttempts`, `deliveryAttempts`, `willAbandon`, `nextDelayMs`. Requires `config.diagnostics.otel.logs = true` to forward to OTEL; otherwise stays as gateway-local log.

  The helpers are no-ops when no event listener is registered, so the plugin is safe to run on a vanilla openclaw without `@openclaw/otel-diagnostics` installed.

  See the new "Telemetry" section in the README for details on the dependency model and the Grafana query for per-class failure breakdown.

### Changed

- **`peerDependencies.openclaw` bumped from `>=2026.3.24` to `>=2026.4.15`.** The diagnostic helpers (`logMessageQueued`, `logMessageProcessed`, `logRunAttempt`, `diagnosticLogger`) are confirmed present in 2026.4.15+; older versions may not export them, which would fail at module import time.

## [0.4.0-beta] — 2026-05-13

Pre-release. Installs only via `npm install openclaw-channel-odoo@beta`; the stable `latest` dist-tag continues to point at 0.3.1.

### Added

- **Persistent inbox.** At-least-once delivery for inbound Odoo chatter messages, surviving gateway restarts (OOM, deploy, SIGKILL). The webhook handler persists each message to disk before returning 202; a three-state on-disk machine (`received` / `dispatching` / `reply_ready`) feeds messages through the agent + XML-RPC delivery pipeline with boot-time crash recovery. Eliminates the silent-loss path where a gateway restart between webhook ACK and dispatch completion would drop messages.

  Architecture highlights:
  - One file per debounce batch under `{stateDir}/odoo-inbound-queue/`; atomic writes (tmp + rename) via the openclaw plugin SDK.
  - `markDispatching` is a real CAS (state `received → dispatching`) under a per-record promise-chain mutex — two concurrent `processBatch` calls for the same batchKey serialize, one wins.
  - `recordFailure` flips `dispatching → received` so post-failure batches are appendable again AND boot recovery routes them through the correct backoff bucket (30s/120s retry timing, not a 15-min staleness defer).
  - Boot recovery partitions on-disk state in a single pass into six buckets (`expired` / `eligibleReplyReady` / `deferred` / `notYetEligibleReceived` / `eligibleReceived` / `corrupt`) plus stale-`dispatching` normalization via `recordFailure(internal_error)`.
  - Webhook handler returns 503 (and rolls back the in-memory dedup mark) on persist failure — Odoo's retry succeeds cleanly without silent loss.
  - Migration normalizer reshapes legacy on-disk JSON on read; idempotent, rolling-deploy safe.

  See [`persistent-inbox-spec.md`](persistent-inbox-spec.md) for the as-built design, state-machine diagram, data model, scheduler/recovery semantics, and the full list of known limitations.

- **New `src/inbox/*` modules** — `types`, `record-lock`, `store`, `queue` (facade: `appendOrCreateBatch` / `markDispatching` / `transitionToReplyReady` / `recordFailure` / `recordDeliverySuccess` / `moveBatchToFailed`), `scheduler` (retries + caps), `recovery` (boot partition). `src/dispatch.ts` is refactored around `createDispatchHandler.processBatch` as the **sole batch-handler entry point** — debouncer onFlush, scheduler retry timer, and boot recovery all converge there. New `src/debouncer-adapter.ts` bridges the in-memory debouncer flush to disk-backed `processBatch`.

- **136 tests across 8 files** — `record-lock`, `store`, `queue`, `scheduler`, `recovery`, `dispatch`, `webhook-handler`, `debouncer-adapter`. Run with `npx tsx --test tests/*.test.ts`.

### CI

- **Pre-release dist-tag routing in `publish.yml`.** Detects the semver pre-release suffix (any version containing `-`, e.g. `0.4.0-beta`, `1.0.0-rc.1`) and publishes with `npm publish --tag beta`. Stable releases continue to publish to the default `latest` dist-tag. Cutting a beta no longer overwrites the stable channel.

### Known limitations (deferred)

Documented in detail in the spec's "Known limitations" section. Headline items:

- Hard-timeout late-deliver double-post (CAS prevents double agent runs; XML-RPC delivery dedup still relies on Odoo-side `requestMessageId` idempotency; bounded by `DISPATCH_MAX_ATTEMPTS`).
- Deferred fresh-`dispatching` timer fires into a defensive no-op — batch stays in `dispatching` until TTL expiry on the next boot.
- Per-record serialization depends on openclaw's `queueMode === "collect"` default (which chains parallel batches as ordered follow-up runs). Don't change `queueMode` for the `odoo` channel without re-evaluating.
- `reply_ready` ignores backoff on restart and never expires by TTL.
- Raw process crash mid-`callReply` doesn't bump `deliveryAttempts`.
- Recovery's stale-`dispatching` normalize bypasses the dispatch cap by one (effective MAX+1 in that path).
- No fallback chatter post on cap exhaustion; no graceful-shutdown hook.

## [0.3.1] — 2026-04-28

### Added

- **Inbound prompt header on `BodyForAgent`.** Every dispatched message is now prefixed with a single-line header carrying the Odoo channel id, record reference, and (when supplied by the inbound webhook) the user's name and partner id. Format: `[odoo] model=<model> res_id=<id> user="<name>" partner_id=<id>`. Lets agent system prompts deterministically detect Odoo inbounds and address the user by name. Header touches only `BodyForAgent` — `Body` / `RawBody` / `CommandBody` stay raw to keep dedup/command logic unaffected.
- **`promptHeader` route field.** Optional boolean per route, default `true`. Set `false` to skip the inbound header for routes that don't need it (e.g. one-shot button-triggered actions or routes that supply their own prompt context).

## [0.3.0] — 2026-04-24

### Breaking

- **Config shape**: top-level `replyMethod` and `replyArgs` are removed. Define per-model routing via `routes` instead. See the [configuration guide](docs/configuration.md) for the full shape; migration is a direct lift into a single catchall route. Config loader throws a pointed error if the old fields are still present.

### Added

- **Per-model routing (`routes`)** — ordered list of match-rules, first match wins, catchall required at the end. Match on exact model or simple `*`-glob (e.g. `helpdesk.*`, `*.lead`).
- **Per-route agent override (`agentId`)** — a route can bind inbound messages for its models to a specific OpenClaw agent, using the same override pattern as the Telegram plugin (`buildAgentSessionKey` + `buildAgentMainSessionKey` + `deriveLastRoutePolicy`).
- **`reply.kwargs`** — XML-RPC keyword arguments are now configurable per route, with:
  - `$name` prefix for references into the variable namespace (`body`, `requestMessageId`, `model`, `resId`)
  - `$$name` for escaped literal strings starting with `$`
  - Any other string/number/boolean/array/object as literal values passed straight through
  - Existing `context: { bot_session_id }` is shallow-merged on top of user-supplied kwargs
- **Robust record-address parsing** in outbound `sendText` — handles both `model:resId` and `odoo:record:model:resId`, including models with dots (e.g. `sale.order.line`).
- **Fail-fast config validation** at startup: every malformed route surfaces with a `routes[N].<path>: <reason>` error, no silent drops.
- **Documentation**: new [configuration guide](docs/configuration.md) with Odoo-side setup, XML-RPC primer, worked examples, and a validation-errors reference table.

### Fixed

- **`webhookSecret` is strictly enforced.** Previously the handler only rejected unauthenticated requests if the secret was set, despite the schema marking it required — meaning a dropped/missing secret silently allowed all inbound. Now: `resolveAccount` throws if the secret is absent at startup, and the handler returns `503` defensively if it becomes missing via hot reload.
- **Reply-message-id round-trip.** Inbound context now sets `ReplyToId: String(last.message_id)`, which flows to `ctx.replyToId` in `attachedResults.sendText`. Without this, the outbound XML-RPC call received `requestMessageId: 0`, which caused the Odoo-side tracking flip + bus notification to be skipped — the reply was sent but the user's panel never refreshed until manual reload.

## [0.2.1] — 2026-03-?? and earlier

Initial public release. See git history.
