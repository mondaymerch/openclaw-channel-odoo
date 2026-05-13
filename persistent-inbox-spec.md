# openclaw-channel-odoo — Persistent Inbox

**Status:** as-built documentation. This file describes what the persistent-inbox feature *is* in the codebase, not what was originally planned. For the rationale behind specific design choices, see commit history.

## Purpose

The persistent inbox provides at-least-once delivery for inbound Odoo chatter messages, surviving gateway restarts (OOM, deploy, SIGKILL). The webhook handler persists each inbound message to disk *before* returning 202 to Odoo; a state-machine on those files survives across process boundaries and feeds them through the agent + XML-RPC delivery pipeline.

Single-gateway / single-PID assumption holds throughout. Cross-instance coordination is out of scope (the per-record lock is in-process only).

## Module map

```
src/
├── inbox/
│   ├── types.ts          — InboxBatch shape, MessageState, constants
│   ├── record-lock.ts    — Per-key promise-chain mutex
│   ├── store.ts          — File CRUD + path resolution + migration normalizer
│   ├── queue.ts          — Facade: appendOrCreateBatch, markDispatching, etc.
│   ├── scheduler.ts      — In-memory retry timer + cap enforcement
│   └── recovery.ts       — Boot-time disk-state partitioning
├── dispatch.ts           — createDispatchHandler — the SOLE batch handler
├── webhook-handler.ts    — HTTP handler: persist-before-ACK
├── debouncer-adapter.ts  — Bridges in-memory debouncer flush → processBatch
└── index.ts              — Plugin wiring: constructs lock, queue, scheduler, handler, debouncer; runs boot recovery
```

The architectural invariant: **`processBatch` (in `dispatch.ts`) is the sole entry point that handles batch lifecycle.** Three trigger paths converge on it — debouncer onFlush adapter, scheduler retry timer fire, boot recovery scheduling — and nothing else touches batch state machinery directly.

## State machine

Three on-disk states plus one terminal directory:

```
    appendOrCreateBatch
            │ (initial)
            ▼
       ┌──────────┐ markDispatching (CAS)  ┌─────────────┐ transitionToReplyReady ┌──────────────┐ recordDeliverySuccess
       │ received │ ─────────────────────► │ dispatching │ ─────────────────────► │ reply_ready  │ ─────────────────────► (unlinked)
       └──────────┘                        └─────────────┘                        └──────────────┘
            ▲                                     │ recordFailure                       │ recordFailure (xmlrpc)
            │                                     │ (silent / internal_error)           │ (state unchanged; counter bumps)
            │                                     ▼                                     │
            └──── recordFailure flips back to "received" ──────────────────────────────┘
                                                                                        │ cap exhausted
            cap exhausted (dispatchAttempts ≥ 3)                                        │ (deliveryAttempts ≥ 5)
                  OR TTL expired (≥ 1h, non-reply_ready only)                           │
                                                                                        ▼
                                                                            ┌──────────────────────┐
                                                                            │ {queueDir}/failed/   │  terminal
                                                                            └──────────────────────┘
```

| State | Meaning | Appendable by new webhooks? |
|---|---|---|
| `received` | Persisted, not currently being dispatched. Either fresh, or in backoff after a prior failure. | **Yes** — `findOpenBatchForRecord` returns it |
| `dispatching` | Agent run in flight. Set atomically by `markDispatching`'s CAS. `inFlightSince` is non-null. | No — new webhook creates a parallel batch |
| `reply_ready` | Agent produced text (saved to disk); XML-RPC delivery pending or in retry. | No |

The whole point of `dispatching` as a distinct state (rather than a flag): the per-record lock + state-CAS gives a real atomic "transition received → dispatching" with no extra primitive needed. Two concurrent `processBatch` calls for the same batchKey both call `markDispatching`; one wins (`{ ok: true }`), the other loses (`{ ok: false, reason: "not_received" }`) and returns early.

The whole point of `recordFailure` flipping `dispatching` → `received` on failure: post-failure batches are appendable again (so a new webhook during backoff joins the existing batch) AND boot recovery routes them through the backoff bucket (so the 30s/120s retry timing isn't accidentally extended to 15 min).

## Data model

`InboxBatch` (`src/inbox/types.ts`):

```ts
type MessageState = "received" | "dispatching" | "reply_ready";

type InboxBatch = {
  batchKey: string;          // UUID; matches the filename stem
  state: MessageState;
  model: string;             // e.g. "crm.lead"
  res_id: number;
  messages: InboundMessage[];

  enqueuedAt: Timestamp;     // when the batch was OPENED (first message arrived)
  closedAt: Timestamp | null;      // set ONCE on first markDispatching; never cleared
  inFlightSince: Timestamp | null; // set by markDispatching; cleared by
                                   // recordFailure + transitionToReplyReady.
                                   // Invariant: non-null ⇔ state === "dispatching"

  dispatchAttempts: number;        // silent + internal_error counter; cap = 3
  deliveryAttempts: number;        // xmlrpc_failure counter; cap = 5
  lastAttemptAt: Timestamp | null; // wall-clock of the most recent recordFailure
  lastError: string | null;
  lastFailureClass: FailureClass | null;  // "silent" | "internal_error" | "xmlrpc_failure"

  reply: { text: string; producedAt: Timestamp } | null;  // populated on transitionToReplyReady
};
```

Field roles, all single-purpose:

- **`state`** answers "what phase of the lifecycle is this batch in?" Three values, each with distinct routing in `processBatch`, `recovery`, and `findOpenBatchForRecord`.
- **`closedAt`** answers "has this batch ever been dispatched?" Set once on the first `markDispatching` (`queue.ts`'s CAS); never cleared, never re-written. Useful for diagnostics + future readers; no current control-flow path keys off it directly.
- **`inFlightSince`** answers "if state is dispatching, when did it start?" Used by boot recovery to compute the staleness boundary (`now - inFlightSince < AGENT_RUN_TIMEOUT_MS` → defer; else normalize).
- **`dispatchAttempts`** / **`deliveryAttempts`** count classified failures (in the JS catch). Caps are enforced in `scheduler.handleFailure` via `nextAction`.
- **`lastAttemptAt`** anchors the next eligible retry time (`lastAttemptAt + backoff[counter-1]`).

`Reply.producedAt` is diagnostic; `messages[].receivedAt` is diagnostic.

## File layout

One file per debounce batch (not per `message_id`):

```
{stateDir}/odoo-inbound-queue/
├── <sanitizedModel>__<res_id>__<batchKey>.json              # active (state: received | dispatching | reply_ready)
├── <sanitizedModel>__<res_id>__<batchKey>.json.<rand>.tmp   # atomic-write temp files
└── failed/
    └── <sanitizedModel>__<res_id>__<batchKey>.json          # terminal failures
```

- `stateDir` is `$OPENCLAW_STATE_DIR` / `$OPENCLAW_HOME/.openclaw` / `~/.openclaw` (in priority order, `store.ts: resolveStateDir`).
- `sanitizedModel` replaces `/` and `\` with `_` defensively.
- Atomic writes go through `writeJsonFileAtomically` (tmp + rename, mode 0o600, ensureDirMode 0o700). Page-cache-atomic but not power-loss-durable — accepted; cloud-VM power loss is rare enough that per-write `fsync` overhead isn't justified.

The filename prefix lets `findOpenBatchForRecord` narrow candidates via `readdir + string prefix match` before touching any file contents.

## Concurrency model

**Per-record promise-chain mutex** (`record-lock.ts`). Keyed on `${model}:${res_id}`. The lock is per-process and in-memory. All read-modify-write operations on a batch file go through `lock.withLock(key, fn)`.

The lock is taken individually by each facade method in `queue.ts`:
- `appendOrCreateBatch` (the full dedup + lookup + write)
- `markDispatching` (the full CAS read-check-write)
- `transitionToReplyReady`
- `recordDeliverySuccess`
- `recordFailure`
- `moveBatchToFailed`

`processBatch` does NOT hold an outer lock across the entire dispatch flow. Between facade calls (e.g. between `markDispatching` and the agent dispatch await), the lock is released. The CAS on state is what prevents two concurrent `processBatch` invocations from both running the agent for the same batchKey: the loser sees `state !== "received"` and exits early.

Per-record lock is also taken by `appendOrCreateBatch`, so a webhook arriving mid-dispatch sees the in-progress `state === "dispatching"` and either creates a parallel batch (if no open one exists) or appends to a sibling open batch (the post-failure backoff case).

### Per-record serialization (relies on openclaw's reply-run registry)

The state CAS in `markDispatching` is keyed on `batchKey`. Two batches with *different* batchKeys for the *same* record (e.g. webhook M2 arriving while batch1 is in `state: "dispatching"`) can each pass their own CAS independently. So per-record serialization is **not** guaranteed by the inbox layer alone — both batches will reach `dispatchReplyWithBufferedBlockDispatcher`.

Per-record serialization comes from the **openclaw runtime layer**:

- `sessionKey` in `dispatch.ts` is derived from `peer.id = "${model}:${res_id}"` via `buildAgentSessionKey` — two batches for the same `(model, res_id)` produce the **same** `sessionKey`.
- openclaw maintains a process-wide `replyRunState.activeRunsByKey: Map<sessionKey, replyOperation>` (resolved via `Symbol.for("openclaw.replyRunRegistry")`). `createReplyOperation` is a CAS on that map and throws `ReplyRunAlreadyActiveError` if a run is already active for the sessionKey.
- The handler around that CAS routes the collision based on **queueMode** (from `messages.queue.mode` config; default is `"collect"` per openclaw's `defaultQueueModeForChannel`). With `mode ∈ { "collect", "followup", "steer-backlog" }` → `enqueue-followup`: the second dispatch queues as a follow-up that fires **after** the current one ends. With other modes → fall through → `AlreadyActive` is caught upstream and a synthetic reply is returned (`"⚠️ Previous run is still shutting down..."`).

In the default config we end up with: first batch runs the agent and posts its reply; second batch's openclaw call is queued as a follow-up; when the first finishes, the follow-up runs the agent on batch2's messages with the conversation history including reply 1; reply 2 is posted in order. **Two separate agent runs, ordered, no synthetic error.**

**This serialization is contingent on queueMode.** If a future config sets a non-`collect`/`followup` mode (e.g. `interrupt`) for the `odoo` channel via `messages.queue.byChannel.odoo` or session-level overrides, parallel batches for the same record would fall through to the `AlreadyActive` handler and the user would see the synthetic "previous run shutting down" text posted to chatter instead of a real agent reply. Don't change queueMode for this channel without re-evaluating this property.

## Webhook flow

`webhook-handler.ts` — invoked by openclaw plugin SDK for `account.webhookPath`.

1. **Auth** (`Bearer ${webhookSecret}`); 401 on mismatch.
2. **Body parse** with `readJsonBodyWithLimit` (413/408/400 on size/timeout/parse).
3. **Field validation** (`model`, `res_id`, `message_id`, `body`); 400 on missing.
4. **Ready gate**: 503 if `isReady() === false` (boot recovery still running). Odoo retries 5xx, so no message is lost during the recovery window. Recovery typically completes in milliseconds when the queue dir is empty.
5. **In-memory dedup**: `dedupe.check(String(message_id))`. If hit → 202 with `{duplicate: true}`. Two-minute TTL; covers Odoo's controller retry window.
6. **Persist before ACK**: `queue.appendOrCreateBatch({ model, res_id, message_id, body, user_name, partner_id })`.
   - `ok: true, didCreate: true | false` → 202 with `batchKey`
   - `ok: false, reason: "duplicate"` → 202 with `{duplicate: true}` (disk-level dedup hit; the queue scans both `queueDir` and `failedDir` for the message_id)
   - `ok: false, reason: "disk_error"` → 503 (Odoo retries)
7. **Fire-and-forget debouncer**: `void debouncer.enqueue(item)`. Errors land in the debouncer's `onError` hook.

The 202 ACK comes *after* a successful queue write. If we cannot persist, we never ACK — Odoo's retry budget covers transient disk hiccups.

## Dispatch flow

`dispatch.ts` — `createDispatchHandler.processBatch(batch)`. Branches on `batch.state`:

### Branch 1: `reply_ready` — re-fire XML-RPC only, skip the agent

The agent already produced text on a prior attempt; we just need to deliver it again.

1. Refuse with `internal_error` if `batch.reply` is unexpectedly null.
2. `postViaCallReply(...)` with the saved `batch.reply.text` and the *last* message_id in the batch as `requestMessageId`.
3. On success: `queue.recordDeliverySuccess` unlinks the file.
4. On throw: `scheduler.handleFailure(ref, "xmlrpc_failure", err)`. `recordFailure` bumps `deliveryAttempts`, leaves state at `reply_ready`, clears `inFlightSince` (already null). Scheduler schedules next retry per `DELIVERY_BACKOFF_MS`.

### Branch 2: `received` — full dispatch via CAS

1. **CAS**: `queue.markDispatching(ref)` reads under the per-record lock; if `state !== "received"` returns `{ ok: false, reason: "not_received" }`. The caller logs and returns — another path is already handling this batch.
2. On `{ ok: true, batch }`: state is now `"dispatching"`, `inFlightSince = now()`, `closedAt` set if it wasn't already.
3. **Agent dispatch**: route resolution + per-route agentId override + session record + `rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher` wrapped in `Promise.race` against `HARD_TIMEOUT_MS` (15 min).
4. **Deliver callback**: when the agent produces text, our wrapped `deliver` runs `queue.transitionToReplyReady(ref, text)` (state → `"reply_ready"`, `reply.text` checkpointed, `inFlightSince` cleared), then `postViaCallReply`, then `queue.recordDeliverySuccess` (unlink). A `callReply` throw is caught and routed through `scheduler.handleFailure(ref, "xmlrpc_failure", err)`. `deliverOutcome` flag tracks whether deliver fired and how, so the outer race resolution doesn't double-classify.
5. **Race resolution**:
   - `{ kind: "timeout" }` with `deliverOutcome === null` → `handleFailure(internal_error)`. The original dispatch promise is left running; if its deliver eventually fires, it races against any retry.
   - `{ kind: "resolved" }` with `deliverOutcome === null` → agent finished without producing text → `handleFailure(silent)`.
   - `{ kind: "resolved" }` with `deliverOutcome` set → success or xmlrpc_failure already classified by deliver wrapper.
6. **Outer catch**: any thrown error (route resolution, session record, unexpected agent runtime error) → `handleFailure(internal_error)`.

### Branch 3: `dispatching` (defensive)

Reached only via boot recovery's deferred-fresh-dispatching path (when the staleness-boundary timer fires). The defensive branch logs an error and returns without action — a known gap: see "Known limitations" below.

### Branch 4 (default, never)

Exhaustive `default` with `const _: never = batch.state` cast — TypeScript compile-error if a future state value is added without an explicit case.

## Failure classification

Two observable axes:

1. Did our own `deliver` callback fire?
2. What did the dispatch's promise resolve to?

| Signal | Class | Counter | Cap |
|---|---|---|---|
| `deliver` fired + `callReply` succeeded | (success — unlinked, no record) | — | — |
| `deliver` fired + `callReply` threw | `xmlrpc_failure` | `deliveryAttempts` | 5 |
| `deliver` NOT fired + race resolved cleanly | `silent` | `dispatchAttempts` | 3 |
| `Promise.race` returned `{ kind: "timeout" }` | `internal_error` | `dispatchAttempts` | 3 |
| Outer try/catch (unexpected exception) | `internal_error` | `dispatchAttempts` | 3 |

## Scheduler

`scheduler.ts` — in-memory `setTimeout` map keyed on `batchKey`.

Public surface:
- `scheduleAt(batch, delayMs)` — re-arm a timer (cancels any prior timer for the same batchKey first).
- `handleFailure(ref, failureClass, err)` — calls `queue.recordFailure`, then computes `nextAction`:
  - If `counter < MAX` → `scheduleAt(updated, backoff[counter - 1])`.
  - If `counter >= MAX` → `queue.moveBatchToFailed(ref)` and cancel any timer.
- `cancelAll()` — for shutdown.

When a timer fires, the scheduler **re-reads the batch from disk** (`readBatch`) before invoking `processBatch(current)`. This re-read-before-fire pattern closes a race where the in-memory snapshot at schedule-time is stale (e.g., the batch was unlinked or moved to `failed/` while waiting).

Timers are `.unref()`'d — they don't block process exit.

## Boot recovery

`recovery.ts` — `runBootRecovery({ paths, queue, scheduler, logger })` runs in an async IIFE in `index.ts` immediately after the queue + scheduler + dispatch handler are constructed, and *before* the webhook ready-gate flips.

Partition pass (single iteration over `listBatches(paths)`):

1. **Expire** — `state !== "reply_ready" && now - enqueuedAt > REPLAY_TTL_MS` (1 h) → `moveBatchToFailed`, bump `summary.expired`.
2. **eligibleReplyReady** — `state === "reply_ready"` → `scheduleAt(batch, 0)`. No stagger, no backoff respect, no TTL. Faster delivery is strictly better than letting a typed reply rot.
3. **dispatching** — split by `inFlightSince` freshness:
   - Fresh (`now - inFlightSince < AGENT_RUN_TIMEOUT_MS`) → `scheduleAt(batch, inFlightSince + 15min - now)`, bump `summary.deferred`. The previous process is presumed still running this dispatch; wait for the staleness boundary.
   - Stale → call `queue.recordFailure(ref, "internal_error", "stale dispatching marker")` synchronously. This flips state back to `received`, bumps `dispatchAttempts`, clears `inFlightSince`, sets `lastAttemptAt = now()`. Then falls through to the received-path logic below. The counter bump gives gateway-flapping a real bound (`DISPATCH_MAX_ATTEMPTS = 3`).
4. **received** — split by next-eligible-at:
   - `lastAttemptAt + backoff[counter - 1] > now` → `scheduleAt(batch, residual)`, bump `summary.notYetEligibleReceived`.
   - Otherwise → push to `eligibleReceived` for stagger pass.
5. **Stagger** — `eligibleReceived[i]` scheduled at `i * REPLAY_STAGGER_MS` (200 ms cadence). Prevents dogpiling the agent concurrency lane on boot when many batches were left on disk.
6. **Log summary** — single line with all bucket counts.

Boot recovery is idempotent: re-running it on the same disk state produces the same scheduling fan-out. The only writes during recovery are `moveBatchToFailed` (expiry) and `recordFailure` (stale-dispatching normalize) — both atomic.

If `runBootRecovery` throws (e.g. disk corruption mid-readdir), `ready` stays `false` and the webhook handler returns 503 indefinitely. Operator intervenes.

## Debouncer adapter

`debouncer-adapter.ts` — bridges the in-memory `createInboundDebouncer` (from openclaw plugin-sdk) to the disk-backed `processBatch`.

```ts
onFlush = async (items: InboundMessage[]) => {
  const last = items[items.length - 1];
  const batch = await findOpenBatchForRecord(paths, last.model, last.res_id);
  if (!batch) {
    logger.info("[odoo] debouncer.onFlush: no open batch ... likely already dispatched");
    return;
  }
  await processBatch(batch);
};
```

The webhook handler has already persisted every message to disk via `queue.appendOrCreateBatch`, so the in-memory debouncer items are effectively a flush trigger; the *content* of the batch is always read from disk. If no open batch exists (state transitioned, batch was unlinked, etc.), the adapter logs and skips — the scheduler retry path picks it up if needed.

## Migration

`normalizeLegacyBatch` in `store.ts` — reshapes legacy on-disk JSON (written with `dispatchedAt: Timestamp | null`) into the current shape (with `closedAt: Timestamp | null` + `inFlightSince: Timestamp | null`).

Idempotent — gated by `"closedAt" in b && b.closedAt !== undefined`. Applied at every parse site: `readBatchFromFile`, `listBatchesInDir`, `findOpenBatchForRecord`, and the read inside `moveBatchToFailed`.

Disambiguation for legacy `state === "received"` with `dispatchedAt !== null`:
- `lastAttemptAt !== null && lastAttemptAt >= dispatchedAt` → a failure was recorded after dispatch started → not in flight at crash → keep `state: "received"`, set `inFlightSince: null`, `closedAt = dispatchedAt`.
- Otherwise → crashed mid-dispatch → flip to `state: "dispatching"`, `inFlightSince = dispatchedAt`, `closedAt = dispatchedAt`.

Reply_ready legacy batches always normalize to `inFlightSince: null` (in-flight is impossible by definition for that state).

The next `writeBatch` after a normalized read drops the legacy `dispatchedAt` key naturally.

## Configuration

All defined in `src/inbox/types.ts`:

| Constant | Default | Purpose |
|---|---|---|
| `REPLAY_TTL_MS` | 1 h | Batches in `state !== "reply_ready"` older than this expire to `failed/` at boot. |
| `HARD_TIMEOUT_MS` | 15 min | Plugin-side hard timeout on `dispatchReplyWithBufferedBlockDispatcher`. Equals `AGENT_RUN_TIMEOUT_MS`. |
| `AGENT_RUN_TIMEOUT_MS` | 15 min | Boot-recovery staleness boundary for `dispatching` batches. Equals `HARD_TIMEOUT_MS`. |
| `REPLAY_STAGGER_MS` | 200 ms | Inter-batch cadence for staggered immediately-eligible received batches at boot. |
| `DISPATCH_MAX_ATTEMPTS` | 3 | Cap on `dispatchAttempts` (silent + internal_error). |
| `DELIVERY_MAX_ATTEMPTS` | 5 | Cap on `deliveryAttempts` (xmlrpc_failure). |
| `DISPATCH_BACKOFF_MS` | `[30s, 120s]` | Per-attempt backoff for silent + internal_error. |
| `DELIVERY_BACKOFF_MS` | `[5s, 25s, 120s, 600s]` | Per-attempt backoff for xmlrpc_failure (matches openclaw outbound queue). |

Other plugin constants in `index.ts`:

| Constant | Default | Purpose |
|---|---|---|
| `INBOUND_DEBOUNCE_MS` | 3 s | Debouncer flush quiescence window. |
| `DEDUPE_TTL_MS` | 2 min | In-memory dedup cache TTL. |
| `DEDUPE_MAX_SIZE` | 10 000 | In-memory dedup cache capacity. |

The hard timeout / staleness boundary is the only value that's intended to be configurable; the rest are hardcoded. (Plumbing for a `dispatchTimeoutMs` config knob is not currently wired through to the type and recovery constants.)

## Fault model

- **Atomic writes are page-cache-atomic, not power-loss-durable.** Survives any process-level crash (SIGKILL, OOM, deploy restart). Does NOT survive a kernel panic or hard reboot within the OS's writeback window (~5-30s).
- **Wall-clock timestamps** (`Date.now()`). Boot recovery compares against fresh `Date.now()`. NTP backwards-slews cause over-deferral (benign). Large forward jumps could flip a fresh `inFlightSince` to "stale" prematurely; in practice NTP jitter is sub-second.
- **Single-gateway / single-PID.** The per-record lock is in-process. Multi-process / HA deployment requires separate inter-process locking and is out of scope.

## Known limitations

These are documented; some may be addressed in follow-up work.

- **Hard-timeout late-deliver double-post.** If the agent hangs past `HARD_TIMEOUT_MS` AND the original dispatch promise eventually invokes its `deliver` AFTER the retry's `markDispatching` succeeded, both attempts can call `postViaCallReply` — up to 2 XML-RPC posts to the same Odoo record. The CAS prevents double agent runs but `transitionToReplyReady` has no per-attempt identity check. Bounded by `DISPATCH_MAX_ATTEMPTS`. Idempotency-key plumbing (server-side dedup keyed on `requestMessageId`) would close this end-to-end.
- **Deferred fresh-`dispatching` batch can get stuck.** When the staleness-boundary timer fires for a batch in `state: "dispatching"`, `processBatch` hits the defensive `case "dispatching"` branch and returns without action. The batch sits in `dispatching` state until TTL expires (1 h). Easy follow-up: have that branch call `scheduler.handleFailure(ref, "internal_error", ...)` to normalize, same as recovery's stale path does at boot.
- **Per-record serialization depends on openclaw's `queueMode`.** When a webhook arrives while the existing batch is in `dispatching` or `reply_ready`, our `findOpenBatchForRecord` returns no open batch and a parallel batch is created with a different `batchKey` for the same `(model, res_id)`. Both batches eventually call `dispatchReplyWithBufferedBlockDispatcher` with the same `sessionKey`. Under the default `queueMode === "collect"` (and `"followup"`, `"steer-backlog"`), openclaw's reply-run registry chains the second dispatch as a follow-up run that fires after the first completes — two ordered agent replies on the same Odoo thread, no synthetic-error reply. If `queueMode` is changed to a non-chaining mode (e.g. `"interrupt"`), the second batch instead hits `ReplyRunAlreadyActiveError` and posts a synthetic "previous run shutting down" reply to chatter. See the "Per-record serialization" subsection under Concurrency model.
- **`reply_ready` ignores backoff on restart.** Boot recovery fires `scheduleAt(batch, 0)` for any `reply_ready` regardless of `lastAttemptAt`. A permanently broken Odoo endpoint with frequent gateway restarts can produce self-spamming until `deliveryAttempts` cap is hit.
- **`reply_ready` never expires by TTL.** The TTL gate is `state !== "reply_ready"`. A permanently un-deliverable reply sits on disk until `deliveryAttempts` cap is hit through live retries.
- **Counters not bumped on raw process crash mid-`callReply`.** The `deliveryAttempts++` happens in the JS catch. A SIGKILL during `await callReply` bypasses the catch. Combined with the prior two items: pathological gateway flapping during `callReply` is unbounded.
- **Recovery's stale-dispatching normalize bypasses the dispatch cap.** A batch entering recovery with `dispatchAttempts = MAX - 1` gets bumped to MAX by `recordFailure` and then *scheduled* (recovery doesn't check the cap after normalize). The next live failure does enforce the cap, so the effective cap is `MAX + 1` in this path.
- **Corrupt batch file → silent split.** `findOpenBatchForRecord` swallows per-file parse errors. If the currently-open batch for a record is corrupt, the next webhook creates a fresh batch. Two open batches end up on disk for the same record. Boot recovery surfaces corruption via `summary.corrupt`, but doesn't quarantine or alert beyond a log line.
- **`.tmp` orphans never cleaned.** Crashes during `writeJsonFileAtomically` can leave `*.json.tmp.*` files. `listBatches` filters them out, so they don't break recovery, but they accumulate forever.
- **No fallback chatter post on cap exhaustion.** When a batch lands in `failed/`, the user sees nothing. The scheduler logs the abandonment but doesn't post a "couldn't process" notice. Intentionally scoped to "per-channel concern outside this module" — not currently handled anywhere.
- **No graceful-shutdown hook.** The openclaw plugin SDK doesn't expose a `stop` lifecycle event. Scheduler timers are `.unref()`'d so they don't block process exit.

## Test coverage

`tests/` covers the inbox modules at unit granularity. Counts as of latest:

| File | Tests | Focus |
|---|---|---|
| `record-lock.test.ts` | 5 | FIFO ordering, draining, parallel keys, error isolation |
| `store.test.ts` | 25 | File CRUD, atomic writes, listBatches, find* lookups, migration normalizer |
| `queue.test.ts` | 33 | Facade methods, dedup, CAS rejection, recordFailure state-flip, full lifecycle |
| `scheduler.test.ts` | 20 | Backoff progression, cap enforcement, timer cancel/replace, re-read-before-fire |
| `recovery.test.ts` | 17 | All six partition buckets, stale-dispatching normalize, legacy-shape integration |
| `dispatch.test.ts` | 6 | reply_ready branch, CAS loser path, defensive dispatching skip, no-route handling |
| `webhook-handler.test.ts` | 6 | Persist-before-ACK outcomes, ready-gate, in-memory dedup short-circuit |
| `debouncer-adapter.test.ts` | 3 | Open batch lookup, no-batch-found skip, multi-item buffer |

Run: `npx tsx --test tests/*.test.ts` (also `npx tsc --noEmit` for type-check).

End-to-end smoke tests (webhook → debouncer flush → agent → callReply round-trip; crash + recovery roundtrip; hard-timeout edge) are not present — they require a substantial mock of the openclaw runtime. Deferred.
