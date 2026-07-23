# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor bumps may contain breaking changes).

## [Unreleased]

## [0.7.0] — 2026-07-23

### Changed

- **Agent-tool terminology corrected: `plan_token` is a consistency hash, not
  approval evidence.** The two-step dry-run/execute flow was documented as an
  "approval flow" whose token recorded "what a human approved" — a false claim
  about the token's security meaning. `plan_token` is a deterministic sha256 of
  the canonical ops; it binds the call ARGS ONLY (never database state) and is
  neither a record of human review nor an authorization boundary. Its sole
  guarantee is consistency: a matching token on execute proves what runs is
  exactly what the dry-run validated. All three agent tools
  (`odoo_spawn_customer_product`, `odoo_create_custom_product`, `odoo_quote_rpc`)
  and their field/hint text now describe a "plan-validation flow". No behaviour
  change — token mechanics (dry-run returns it, execute requires a match,
  `plan_token_required` / `plan_token_mismatch`) are unchanged.

- **`odoo_quote_rpc` labelled accurately as a scoped XML-RPC bridge.** Its
  description and header comment now open with "scoped XML-RPC bridge: a
  model/method-allowlisted `execute_kw` passthrough using gateway-held
  credentials", and state explicitly that within the permitted models the agent
  constructs general args (data-level, not action-level access), that
  product-data writes are impossible both directly and through nested x2many
  command cascades, and that the two typed tools are the only product-creation
  route.

### Added

- **Per-RPC timeout (`channels.odoo.rpcTimeoutMs`, default 120000).**
  `OdooClient.executeKw` previously wrapped the XML-RPC `methodCall` with no
  timeout, so a hung Odoo call stalled the operation until the far larger
  channel-level dispatch timeout (`agentTimeoutMs`, up to 1 h). Each `execute_kw`
  is now bounded: an unsettled call rejects with a structured `RpcTimeoutError`
  after `rpcTimeoutMs` (range `[1000, 600000]`). A late transport callback
  arriving after the timeout is ignored (single-settle guard). Through the
  `odoo_quote_rpc` bridge this surfaces as an `rpc_timeout` op error with
  unchanged per-op status semantics (prior ops `executed`, the timed-out op
  `failed`, later ops `not_run`). Its hint notes the write may or may not have
  landed — verify state via `odoo_search_read` and retry with a NEW `client_ref`
  (the old ref replays the stored failure by design). No retry/backoff is added;
  `client_ref` idempotency plus skill-side verification is the deliberate model.

## [0.6.0] — 2026-07-21

### Added

- **`odoo_quote_rpc` — TEMPORARY scoped `execute_kw` bridge for quote editing**
  (commit `9c346b9`). A model/method-allowlisted passthrough that runs Odoo
  `execute_kw` with the gateway's credentials, but ONLY for the (model, method)
  pairs in a hardcoded `QUOTE_RPC_SCOPE` (`sale.order` create/write/copy/
  message_post/action_recalculate_handling_costs; `sale.order.line`
  write/unlink; `print.design` create/write/unlink; `product.template` /
  `product.product` message_post only), enforced in plugin code before any RPC
  leaves the process. A hard-forbidden gate (`product.template` /
  `product.product` / `product.supplierinfo` ×
  create/write/unlink/copy/name_create/copy_data/load) runs FIRST so a mistaken
  scope-table edit can't open a product write. Two-step plan-validation flow with
  a sha256 `plan_token` (args-only consistency hash, no drift detection) and a
  required `client_ref` idempotency key (in-memory, 24 h TTL, cleared on
  restart); batches run sequentially and STOP on the first error with per-op
  `executed` / `failed` / `not_run` status. Exists only until the deterministic
  tools (`update_quote` / `configure_addons` wave 2, `create_quote` wave 3)
  replace it.

### Fixed

- **x2many command-cascade guard closes a product-write bypass** (commit
  `424bf2a`). The (model, method) allowlist alone was insufficient: Odoo cascades
  x2many command tuples inside `vals` onto the comodel below `execute_kw`, so a
  permitted `sale.order` write/create carrying
  `{"product_to_archive_ids": [[0,0,{…,"seller_ids":[[0,0,{}]]}]]}` would be full
  product CRUD. The bridge now recursively scans op args/kwargs and rejects any
  comodel-mutating command (codes 0/1/2/5) with `unsafe_relational_write`; the
  one exception is `order_line` creation on `sale.order.create`, whose line vals
  are scanned the same way. Relation-only commands (link / unlink-relation /
  replace, codes 3/4/6) are allowed.

## [0.5.0] — 2026-07-17

### Added

- **Two typed product-creation agent tools** backed by the new `agent.api` Odoo
  service model (part of the `openclaw_agent_api` project):
  - `odoo_spawn_customer_product` — spawn a platform-bound customer product from
    a catalogue parent template (reuse-first dedup, validity gates, optional
    SO-line append).
  - `odoo_create_custom_product` — create an out-of-catalogue custom product
    (product.template + product.supplierinfo, derived sale price, optional
    SO-line append).

  Both tools are thin transport following the existing `odoo_search_read`
  pattern: they forward the payload as the single positional argument to the
  `agent.api` method and return its structured response envelope VERBATIM
  (never transformed, `ok:false` failures never swallowed). All validation,
  dedup, dry-run plan-validation, idempotency and VAT/price correctness live in
  the Odoo method. TypeBox schemas enforce structure/type/required/enums and
  `additionalProperties: false` (blocking fields the agent must never pass, e.g.
  `partner`, `list_price`); value semantics are validated server-side so every
  problem is returned in one response.

  Both tool names are declared under `contracts.tools` in the manifest —
  required for current OpenClaw core to register them (see 0.4.3) — and a new
  `client.callMethod()` adds a generic `execute_kw` transport that merges
  `bot_session_id` into the call context without clobbering a caller-supplied
  context object (mirroring `callReply`'s merge, not `searchRead`'s wholesale
  overwrite).

## [0.4.3] — 2026-06-11

### Fixed

- **`odoo_search_read` now registers on current OpenClaw core.** The manifest did
  not declare `contracts.tools`, so core (>= 2026.5.31) refused to register the
  tool: `registerTool` requires every agent tool to be declared under
  `contracts.tools` first, otherwise it logs a diagnostic and returns without
  registering. The tool was silently absent from every agent's tool surface.
  Agents restricted via `tools.allow: ["odoo_search_read"]` therefore failed at
  precheck with `No callable tools remain after resolving explicit tool allowlist
  … no registered tools matched`, which surfaced downstream as Raven recipe-run
  timeouts (e.g. Strategic Client Investigation, Customer Success Handover).
  Added `"contracts": { "tools": ["odoo_search_read"] }` to the manifest so the
  read-only tool registers and explicit allowlists resolve correctly.

## [0.4.2] — 2026-05-26

### Added

- **Inbox dispatch admission control.** Debounced Odoo batches now drain through
  the retry scheduler instead of directly starting agent runs. The scheduler can
  defer batches without consuming retry attempts when concurrency, dispatch
  spacing, process RSS, or event-loop delay limits are hit.
- New `channels.odoo` backpressure knobs:
  `maxConcurrentDispatches`, `minDispatchSpacingMs`,
  `dispatchAdmissionRetryMs`, `maxProcessRssMb`, and
  `maxEventLoopDelayMs`.

## [0.4.1-beta.1] — 2026-05-22

### Added

- **Routing-key route matching.** Inbound webhooks may carry an optional `routingKey` (or `routing_key`) field; routes can match on it with `{ routingKey: "<glob>" }` or combined `{ model: "<glob>", routingKey: "<glob>" }` (AND-semantics). Same `*` glob syntax as model matches. Existing model-only routes and Odoo controllers continue to work unchanged.

  **Batch identity is now `(model, res_id, routing_key)`.** Two messages on the same record with different routing keys form independent persistent-inbox batches: separate debounce windows, separate agent runs. Messages with the same key (or both absent) still batch together as before.

  `routingKey` joins the known variables namespace — references like `["body", "routingKey"]` in `reply.args` and `"$routingKey"` in `reply.kwargs` resolve to the inbound's value (or `null` when absent). The prompt header gains a `routing_key="..."` field when the inbound supplied one (skipped otherwise, same convention as `user_name`).

  Configs are camelCase-only (`routingKey`); payloads accept both `routingKey` and `routing_key` so Odoo controllers can use whichever feels natural. On-disk batches written before this change load with `routing_key: null` automatically — no manual migration.

- **`channels.odoo.debounceMs` and `channels.odoo.agentTimeoutMs` are now config-tunable.** Both optional with current defaults preserved (3000 ms and 900_000 ms / 15 min respectively). Operators can tighten the debounce for low-volume records or extend the agent timeout for heavier reasoning without forking the plugin.
  - `debounceMs` accepts integers in `[0, 60000]`.
  - `agentTimeoutMs` accepts integers in `[30000, REPLAY_TTL_MS]` (i.e. ≤ 1 h). Values above that would let the on-disk TTL fire before the in-process timeout, leaving the batch in `dispatching` until the next boot's recovery sweep — rejected at startup with a clear error.

### Fixed

- **Deferred in-flight recovery no longer leaves batches stuck in `dispatching`.** When boot recovery defers a fresh in-flight batch until its hard-timeout boundary, the scheduled retry now normalizes the stale marker through `scheduler.handleFailure(..., "internal_error", ...)`, preserving the normal dispatch backoff/cap behavior instead of waiting for TTL.

## [0.4.0] — 2026-05-15

Promotes [0.4.0-beta](#040-beta--2026-05-13) to the stable `latest` dist-tag. `npm install openclaw-channel-odoo` now resolves to 0.4.0; existing 0.3.1 installs are unaffected until they upgrade.

The headline feature — the **persistent inbox** for at-least-once delivery of inbound chatter messages across gateway restarts — was introduced and documented in 0.4.0-beta. The full design (state machine, data model, scheduler/recovery semantics, concurrency model, known limitations) lives in [`persistent-inbox-spec.md`](persistent-inbox-spec.md).

### Added (since 0.4.0-beta)

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

### Changed (since 0.4.0-beta)

- **`peerDependencies.openclaw` bumped from `>=2026.3.24` to `>=2026.4.15`.** The diagnostic helpers (`logMessageQueued`, `logMessageProcessed`, `logRunAttempt`, `diagnosticLogger`) are confirmed present in 2026.4.15+; older versions may not export them, which would fail at module import time.

### CI (since 0.4.0-beta)

- **Test suite now runs in CI** on every PR + push to main (136 tests across 8 files). Previously CI only ran type-check + build. Implementation uses `npm install --no-save tsx@^4.21.0` so the lockfile stays pristine across platforms (Mac can't compile openclaw's optional `@discordjs/opus` native binding, which would otherwise desync the lockfile between local dev and Linux CI).

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
