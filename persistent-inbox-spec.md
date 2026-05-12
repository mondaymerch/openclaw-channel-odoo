# openclaw-channel-odoo — Persistent Inbox Spec

## Goal

At-least-once delivery for inbound Odoo chatter messages, surviving gateway restarts (OOM, deploy, SIGKILL). Eliminate silent message loss.

## Non-goals

- **Exactly-once delivery** — accepted as a v1 limitation: retries on `reply_ready` can in theory produce duplicate chatter posts if Odoo's response is ambiguous (network reset between Odoo's commit and our receipt). Plumbing for the fix is included now (see "Idempotency key") — closing it requires a small Odoo-addon change that's deferred to v2.
- **In-process agent recovery** — we don't try to resume a half-run agent turn. Restarted runs start fresh from the inbound message.
- **Changes to openclaw core** — pure plugin-side implementation using `@openclaw/fs-safe/store` primitives.

## On-disk state machine

```
   ┌──────────┐  agent produces reply   ┌──────────────┐  XML-RPC ok
   │ received │ ──────────────────────► │  reply_ready │ ─────────────►  (unlinked)
   └──────────┘     (text saved)        └──────────────┘
        ↻                                       ↻
   silent / internal_error / timeout      XML-RPC fail
   (dispatchAttempts++, cap 3)            (deliveryAttempts++, cap 5)
        │                                       │
        ├── cap hit                             └── cap hit ──┐
        └── enqueuedAt + 1h (TTL) ──┐                         │
                                    ▼                         ▼
                  ┌──────────────────────────────────────────────┐
                  │            {queueDir}/failed/                 │
                  │       (fallback chatter post fires)           │
                  └──────────────────────────────────────────────┘
```

Three on-disk states plus one terminal:
- `received` — webhook captured, no reply produced yet. Self-loops on dispatch failure until either `dispatchAttempts` hits 3 or the 1-hour TTL elapses → `failed/`.
- `reply_ready` — agent produced text, XML-RPC not yet confirmed. Self-loops on XML-RPC failure until `deliveryAttempts` hits 5 → `failed/`. **No TTL** — the agent's text is sunk cost; we deliver it eventually.
- `failed/` — terminal, moved aside, fallback chatter post fires (best-effort).
- *(unlinked)* — success terminal. File simply removed from disk.

The only forward inter-state transition is `received → reply_ready` (when our `deliver` callback fires and we checkpoint the reply text). Everything else is a self-loop on the same state or an exit to `failed/` / unlinked.

### Why `reply_ready` is its own state

The file is **not** part of the in-process retry mechanism — in-process XML-RPC retries use an in-memory `setTimeout` loop and don't need disk. The `reply_ready` file is purely a **checkpoint for crash-survival**: it preserves the agent's already-produced text so that if the gateway dies mid-delivery, recovery can re-attempt XML-RPC without re-running the agent (which would burn tokens and risk producing different text, potentially a duplicate visible reply if the prior XML-RPC actually succeeded).

Concretely, the file gets written:
1. **Once** at the `received` → `reply_ready` transition (inside our `deliver` callback, before the first `callReply` attempt)
2. **Updated** after each failed `callReply` (to bump `deliveryAttempts`, set `lastAttemptAt`, record `lastError`) so a crash mid-retry-loop produces a correct restart state
3. **Unlinked** on `callReply` success

This is the same conservative pattern openclaw uses in its outbound delivery queue.

## File layout

```
{stateDir}/odoo-inbound-queue/
├── <message_id>.json              # active entries (state: received | reply_ready)
├── <message_id>.json.tmp.<n>      # atomic-write temp files
└── failed/
    └── <message_id>.json          # terminal failures
```

File content (rough):

```json
{
  "id": "<uuid>",
  "state": "received | reply_ready",
  "message_id": 741,
  "model": "crm.lead",
  "res_id": 106665,
  "body": "...",
  "user_name": "Sila",
  "partner_id": 5432,
  "enqueuedAt": 1715201234567,
  "idempotencyKey": "741",         // stable per entry; see "Idempotency key"

  "dispatchedAt": null,            // set when handoff to dispatchReplyWithBufferedBlockDispatcher starts; cleared on resolution
  "dispatchAttempts": 0,
  "deliveryAttempts": 0,
  "lastAttemptAt": null,
  "lastError": null,
  "lastFailureClass": null,        // "silent" | "internal_error" | "xmlrpc_failure"

  "reply": { "text": "...", "producedAt": ... }    // only when state=reply_ready
}
```

Use `writeJsonDurableQueueEntry` from `@openclaw/fs-safe/store` for atomic writes.

## Fault model assumptions

The durability claims in this spec hold against the following fault model. Violations of these assumptions are out of scope.

- **Atomic writes are page-cache-atomic, not power-loss-durable.** Each entry is written via `<file>.tmp.<random>` + `rename`, which is POSIX-atomic against concurrent observers and survives any process-level crash (SIGKILL, OOM, deploy restart). No `fsync` is called on the file or directory, so a kernel panic, hard reboot, or actual power loss within the OS's writeback window (typically 5–30s) can lose the last few writes. We accept this — process crashes are the common failure mode this spec targets, and cloud-VM power loss is rare enough not to justify per-write fsync overhead. If stronger durability is needed later, expose a `fsync: true` plugin-config option.
- **Timestamps are wall-clock (`Date.now()`).** Both `enqueuedAt` and `dispatchedAt` are wall-clock millis, compared at recovery time against a fresh `Date.now()`. Backwards NTP slews are benign — they cause over-deferral, not under-recovery. Large forward jumps (e.g., container with bad initial clock that NTP corrects upward after first dispatch) could prematurely flip a fresh `dispatchedAt` marker to stale, firing a parallel retry. Practical NTP jitter is sub-second; only pathological clock failures (manual `date -s`, VM resume with very stale clock) cross the 15-minute `AGENT_RUN_TIMEOUT_MS` threshold. We use wall-clock because cross-process timestamp comparisons (boot recovery vs. previous-process dispatch) require it — `process.hrtime.bigint()` resets per process and can't bridge restarts.

## Where it plugs into existing plugin code

| Existing code | Change |
|---|---|
| `webhook-handler.ts` (before `respond(202, ...)`) | Write `received` file. ACK only after write succeeds. |
| `dispatch.ts` (before `await dispatchReplyWithBufferedBlockDispatcher(...)`) | Atomically set `dispatchedAt = now` on the file(s) in the batch. |
| `dispatch.ts` (around the `deliver` callback) | Wrap `deliver`: write `reply_ready` with text BEFORE invoking `callReply`. On XML-RPC success → unlink. On XML-RPC failure → leave file, schedule retry. |
| `dispatch.ts` (after `dispatchReplyWithBufferedBlockDispatcher` resolves) | Clear `dispatchedAt`. Inspect `DispatchFromConfigResult`: classify outcome, write back `lastFailureClass` + `lastError`, schedule retry. |
| `index.ts` `registerFull` startup | Scan queue dir, replay pending files (`received` with no/stale `dispatchedAt` → debouncer; `received` with fresh `dispatchedAt` → defer until staleness; `reply_ready` → XML-RPC) |
| `channel.ts` `startAccount` (currently empty `stop` callback) | Optional graceful-shutdown hook: write a per-record "replay-immediately" marker so on boot we don't wait. |

## Retry classification

Two observable axes determine the next action:

1. **Did our own `deliver` callback fire?** (we control it — we know directly)
2. **What did `dispatchReplyWithBufferedBlockDispatcher`'s promise resolve to?** (`DispatchFromConfigResult`, or threw)

Classification table:

| Signal | Class | Counter | Cap |
|---|---|---|---|
| `deliver` called + our `callReply` succeeded | success | — | — (unlink) |
| `deliver` called + our `callReply` threw | `xmlrpc_failure` | `deliveryAttempts` | 5 |
| `deliver` NOT called + `queuedFinal: false` (clean resolution) | `silent` | `dispatchAttempts` | 3 |
| Promise rejected (try/catch hit) OR dispatch timed out (see "Dispatch timeout") | `internal_error` | `dispatchAttempts` | 3 |

Notes:
- On openclaw 2026.5.4 there is no `beforeAgentRunBlocked` signal — dispatch always proceeds. A "session busy" condition in PI runtime is handled internally by openclaw (abort + run-now, or enqueue-followup), not surfaced as a separate failure class. For codex/CLI agents there is no session lock at all. So no `blocked` row exists. A future openclaw version may introduce this signal; if so, add a row and a counter at that point.
- `failedCounts` from `DispatchFromConfigResult` is **not used for control flow**. It's keyed by `ReplyDispatchKind = "tool" | "block" | "final"`; non-zero values typically reflect streaming chunk drops (`block`) which don't affect whether the final reply landed. Recorded in `lastError` for diagnostics only.
- "Agent crashed" / "LLM provider down" don't have a dedicated class. They collapse into either `silent` (caught internally, no final produced) or `internal_error` (propagated as exception, or our plugin-side dispatch timeout fired) — both flow through the agent-retry bucket.

## Backoff schedules

- **Dispatch retry (`silent` / `internal_error`)** — `[30s, 2min]`, cap 3 attempts → failed/
- **Delivery retry (`xmlrpc_failure`)** — `[5s, 25s, 2min, 10min]`, cap 5 attempts → failed/ (matches openclaw outbound queue)

## Plugin-reload safety (why this design is restart-tolerant)

A common concern: if the plugin reloads (or its instance resets) while an agent is mid-run on a long inbound — 5-10 minutes of tool calls and analysis — won't boot recovery fire a retry, creating a parallel run that re-processes the same message?

**No.** The `dispatchedAt` marker prevents premature retries from boot recovery, and the plugin-side dispatch timeout (see "Dispatch timeout") guarantees that any in-flight dispatch resolves one way or another within `AGENT_RUN_TIMEOUT_MS`.

### Primary mechanism: `dispatchedAt` marker

Right before our `dispatch.ts` awaits `dispatchReplyWithBufferedBlockDispatcher`, we atomically write `dispatchedAt = now` on the file. When the await resolves (any outcome — success, classified failure, or our hard timeout firing), we clear it.

On boot recovery, for each `received` file:
- `dispatchedAt` is null → never dispatched → retry normally
- `dispatchedAt` is fresh (`now - dispatchedAt < AGENT_RUN_TIMEOUT_MS`) → assume the previous dispatch is still in flight → **skip retry**, schedule a re-check at `dispatchedAt + AGENT_RUN_TIMEOUT_MS`
- `dispatchedAt` is stale → previous dispatch is presumed dead (process restarted, or our hard timeout fired and the dispatch was already retried under a fresh `dispatchedAt`) → retry

`AGENT_RUN_TIMEOUT_MS = 900000` (15 min) — chosen to cover the longest legitimate codex/CLI agent run we'd see in production, even with heavy tool use. Shorter values risk a stale-marker retry firing during a healthy long run; longer values delay recovery from genuine hangs without buying any safety. This value MUST equal `HARD_TIMEOUT_MS` (see "Dispatch timeout") so that the in-process timeout and the boot recovery staleness threshold agree.

This eliminates the busy-loop scenario where new retries hammered the dispatch path while a long run was still in flight.

### Why old `deliver` closures keep doing the work

When we call `dispatchReplyWithBufferedBlockDispatcher`, our `deliver` callback is captured in openclaw's Promise chain. After a plugin reload (which doesn't kill the Node.js process), the closure is still alive — closures hold their own references; the Promise chain keeps them garbage-collection-rooted. When the agent finishes, the OLD `deliver` fires — calls our OLD `callReply` — does its XML-RPC post — unlinks the file. Same disk path as the new plugin instance would use, so the cleanup is correct.

`ACTIVE_EMBEDDED_RUNS` is keyed by `Symbol.for("openclaw.embeddedRunState")` — a process-wide global singleton. It only dies on full Node.js process restart.

### Backstop: plugin-side dispatch timeout

If a dispatch hangs (CLI process stuck on a tool call, MCP server frozen, model API not returning, etc.), our `Promise.race` with `HARD_TIMEOUT_MS` fires after 15 min. We classify as `internal_error` and schedule the standard retry. The dangling dispatch promise keeps running in the background — we accept the leak; it will either eventually resolve (in which case its `deliver` may race with our retry, handled by the "re-read file before fire" check below) or never resolve and get GC'd at process exit.

On openclaw 2026.5.4 there is no `stuckSessionAbortMs` config that bounds the dispatch promise — the plugin-side timeout is the **only** mechanism that rescues a wedged dispatch within a single process lifetime. Without it, a hung dispatch holds an entry hostage until next gateway restart.

Because `HARD_TIMEOUT_MS == AGENT_RUN_TIMEOUT_MS`, the in-process timeout fires at the same boundary boot recovery would use to declare the marker stale. The two mechanisms reinforce each other: in-process recovery is faster (catches hangs without waiting for a restart); boot recovery is the cross-process backstop.

### Subtle requirement: re-read file before firing a retry

Between "schedule retry" and "backoff later, retry fires", the OLD closure (or a dangling timed-out dispatch's late `deliver`) might unlink the file. We must re-check existence at fire time, not rely on the scheduling snapshot:

```ts
function fireRetry(entryId) {
  const current = await readQueueEntry(entryId);
  if (!current) return;       // already handled — no-op
  // ... proceed
}
```

Cheap, closes the race.

### End-to-end guarantee

Regardless of how many plugin reloads happen during an in-flight agent run, exactly one agent run processes the message, and the file is unlinked by whichever closure finishes the delivery.

## Dispatch timeout

`dispatchReplyWithBufferedBlockDispatcher` is wrapped in `Promise.race([dispatch, sleep(HARD_TIMEOUT_MS)])`. If the timeout wins, we treat it as an `internal_error` outcome (the same path a thrown promise takes), clear `dispatchedAt`, and schedule a retry. The losing dispatch promise dangles in the background — accepted.

```ts
const timeout = new Promise<{ kind: "timeout" }>((resolve) =>
  setTimeout(() => resolve({ kind: "timeout" }), HARD_TIMEOUT_MS).unref(),
);
const result = await Promise.race([
  dispatchReplyWithBufferedBlockDispatcher({...}).then((r) => ({ kind: "ok" as const, result: r })),
  timeout,
]);
if (result.kind === "timeout") {
  // Treat as internal_error. Our `deliver` may still fire later against the
  // file; the "re-read before fire" check in the scheduler closes the race.
}
```

`HARD_TIMEOUT_MS = AGENT_RUN_TIMEOUT_MS = 900000` (15 min) by default. The two are conceptually the same number — "how long is reasonable for an in-flight dispatch before we consider it dead" — and MUST stay equal so the in-process timeout and the boot recovery staleness threshold agree.

### Configuration override

The timeout is a single top-level plugin-config knob (not per-route):

```yaml
channels:
  odoo:
    accounts:
      default:
        dispatchTimeoutMs: 900000   # optional, default 15 min
```

When overridden, the same value applies to both `HARD_TIMEOUT_MS` and `AGENT_RUN_TIMEOUT_MS` — they cannot drift apart.

### Why no openclaw-side timeout to rely on

Spec previously recommended `diagnostics.stuckSessionAbortMs: 180000`. **That config does not exist on openclaw 2026.5.4** — only `stuckSessionWarnMs` (diagnostic warning, doesn't abort). It's added in 2026.5.9+. While we're targeting 2026.5.4, the plugin-side timeout is mandatory; we cannot delegate. When/if we adopt openclaw 5.9+, the plugin timeout can be a defense-in-depth backstop and openclaw can be set to a shorter abort window.

## Recovery (boot)

On `registerFull`, before accepting new webhooks:
1. List `{stateDir}/odoo-inbound-queue/*.json`
2. **Expire stale `received` entries**: if `state === "received"` AND `now - enqueuedAt > REPLAY_TTL_MS` (1 hour), move the entry straight to `failed/` and post the fallback chatter message. Reasoning: if a user wrote to a record's chatter an hour ago and we never even dispatched it, replying now is confusing — they've moved on. Better to escalate ("we missed your message, please retry") than to surprise them with a late agent response.

   **`reply_ready` entries are NEVER expired.** The agent's text is already produced — sunk cost. A late real reply (even days later) is strictly better than discarding the work and posting a "we couldn't process" fallback, which would be factually wrong (we *did* process; we just couldn't deliver). The only path to `failed/` for a `reply_ready` entry is exhausting the delivery cap (5 XML-RPC failures).
3. **Check `dispatchedAt` — only for `received` entries** (see "Plugin-reload safety"):
   - State is `received` AND `dispatchedAt` is fresh (`now - dispatchedAt < AGENT_RUN_TIMEOUT_MS`) → previous dispatch presumed still in flight → schedule a re-check at `dispatchedAt + AGENT_RUN_TIMEOUT_MS`, do NOT retry
   - State is `received` AND `dispatchedAt` is null or stale → eligible for retry, continue to step 4
   - State is `reply_ready` → **ignore `dispatchedAt` entirely**. The agent already produced `reply.text` before any crash window inside `deliver`, so the deferral logic doesn't help; we want immediate XML-RPC redelivery. Continue to step 4.
4. For each remaining entry, check `lastAttemptAt + backoff(attempts) vs now`:
   - **Immediately eligible** (never attempted, or backoff has passed) → schedule via stagger (see below)
   - **Not yet eligible** → in-memory `setTimeout` for the exact `nextEligibleAt`
5. **Stagger immediately-eligible `received` entries** at `REPLAY_STAGGER_MS` cadence (200ms):
   ```
   t=0ms     → debouncer.enqueue(entry 1)
   t=200ms   → debouncer.enqueue(entry 2)
   t=400ms   → debouncer.enqueue(entry 3)
   ...
   ```
   Reason: firing all eligible entries simultaneously would saturate openclaw's agent concurrency lane (default 4) instantly, pushing any new webhook arriving in the first ~30s to the back of the queue. Spreading enqueue over a short window lets incoming webhooks slot in fairly between replay entries.
   
   `reply_ready` entries are **not** staggered — they call XML-RPC directly, don't compete for agent slots, and faster delivery is strictly better.
6. **Log a boot summary** once recovery has fanned out:
   ```
   [odoo] replay: 10 eligible (8 received + 2 reply_ready), 3 scheduled, 2 deferred (dispatchedAt fresh), 5 expired → failed/
   ```
   Cheap to produce, makes post-incident analysis 10× faster.

After boot recovery completes, retry timing is driven exclusively by in-memory `setTimeout`. Each failed attempt schedules its next try based on backoff. If the gateway crashes between attempts, the next boot's recovery scan picks the entry up again — no separate background sweeper needed.

Tunables:
- `REPLAY_TTL_MS = 60 * 60 * 1000` (1 hour, hardcoded) — applies **only to `received` entries**. `reply_ready` entries never expire by TTL (see Recovery step 2).
- `REPLAY_STAGGER_MS = 200` (hardcoded) — small enough that 10 entries finish staggering in under 2s
- `AGENT_RUN_TIMEOUT_MS = HARD_TIMEOUT_MS = 15 * 60 * 1000` (15 min, **overridable via `dispatchTimeoutMs` top-level account config**) — after this, a `dispatchedAt` marker is considered stale AND the in-process dispatch promise is forced to resolve via `Promise.race`. Sized to cover the longest legitimate codex/CLI agent run; shorter values risk killing a healthy long run, longer values delay recovery from genuine hangs.

## Dedup interaction

Drop or keep the in-memory `dedupeCache`? **Keep** for hot-path speed, but the file's existence becomes the authoritative dedup key:

- Webhook receives `message_id` X → if `<X>.json` exists in **either** `{queueDir}` (active) **or** `{queueDir}/failed/` (already abandoned) → respond 202 immediately, do NOT enqueue.
- Cache miss + no file in either location → proceed to write + enqueue.

Including `failed/` in the dedup check matters: Odoo retries a webhook on timeout, and that retry can land minutes-to-hours after we've already moved an entry to `failed/` and posted the fallback chatter. Without this rule, the retry would create a fresh `received` entry for an already-dead message — we'd run the agent again and post a real reply layered on top of the "we couldn't process" fallback, confusing the user.

## Idempotency key (preparation for exactly-once delivery)

The at-least-once non-goal is bounded by one specific failure: a retry of a `reply_ready` entry where the previous XML-RPC call's response got lost in flight (network reset, gateway crash between Odoo's commit and our unlink). The user sees the same reply posted twice.

Closing this requires server-side dedup: Odoo must recognize a retry of an already-posted reply and no-op. We can do that with a deterministic key passed alongside each post. **This spec plumbs the key plugin-side now but does not transmit it by default.** Activating it later is a server change + a route-config tweak — no plugin code change needed.

### Phase 1 (this spec) — plumbing only

- Every inbox entry gets an `idempotencyKey: string` field, written at file creation. Value = `String(message_id)` — already globally unique on Odoo's `mail.message` table.
- `callReply`'s internal `argMap` exposes `idempotencyKey` as a referenceable variable (alongside `body`, `requestMessageId`, `model`, `resId`).
- Default route configs do **not** include the kwarg, so XML-RPC posts go out unchanged. Nothing changes for Odoo today.

### Phase 2 (later) — server-side activation

- Add an optional `idempotency_key` kwarg to `openclaw_post_reply` in the Odoo addon. Server checks for a prior `mail.message` on `(model, res_id)` carrying this key in a custom field; if present → success no-op.
- Update the route config in `openclaw.json` to opt in:
  ```yaml
  channels:
    odoo:
      routes:
        - model: crm.lead
          reply:
            method: openclaw_post_reply
            kwargs:
              idempotency_key: { kind: ref, name: idempotencyKey }
  ```
- Deploy Odoo + flip config. Plugin code unchanged.

After Phase 2 ships, the ambiguous-response duplicate case is closed: any retry of a `reply_ready` entry posts with the same key, server dedups, our `deliver` callback sees success, file unlinks. Exactly-once at near-zero runtime cost.

## Failed-bucket fallback

When a file moves to `failed/`:
1. Move file (use `moveJsonDurableQueueEntryToFailed`)
2. Best-effort post a chatter message to the record: *"⚠️ The agent couldn't process this message after several attempts. Please try again later or notify an admin."*
3. Log a `[odoo] inbound abandoned` line with `message_id`, `lastFailureClass`, `lastError`
4. (Optional, future) Emit a diagnostic event for alerting

## Graceful-shutdown hook (optional, low priority)

In the `stop` callback inside `runStoppablePassiveMonitor`:
1. Iterate in-memory active dispatches; for each, write a `"interrupted_at": <now>` marker on its file
2. On boot, these files get prioritized for immediate replay (skip backoff)

Skip this in v1 if it adds complexity — janitor scan handles it anyway, just slower.

## Out of scope for v1

- Cross-instance coordination (assumes single gateway process owns the queue dir — true today, would need locking if we go HA)
- Compaction / archival of `failed/` (manual ops for now)
- Metrics endpoint (`/odoo/queue/stats`) — useful but additive
- Configurable backoff via plugin config — hardcode initially

## Tests to write

- Webhook write fails (disk full) → must return 503, not 202
- Two webhooks with same message_id → second one detected as dup
- Process killed mid-dispatch → file in `received`, replayed on boot
- Process killed mid-XML-RPC → file in `reply_ready`, redelivered on boot
- Agent always silent → 3 attempts → moved to `failed/` + fallback post
- XML-RPC errors transient → succeeds on retry, file unlinked
- 1000 entries in queue dir at boot → expired `received` entries (>1h old) skip replay and go to `failed/` with fallback post; only recent ones replay; recovery does not block webhook handler
- `received` entry with `enqueuedAt` 65 min ago → moved to `failed/` on boot, fallback chatter post fires
- `reply_ready` entry with `enqueuedAt` 25 hours ago → NOT moved to failed; recovery attempts XML-RPC delivery normally (never expires by TTL)

## Resolved questions

- **What does `failedCounts` mean?** Per-kind (`tool` / `block` / `final`) count of dispatch failures from openclaw's reply dispatcher. Useful for diagnostics, NOT for our retry decision — we read XML-RPC success/failure directly from inside our `deliver` callback.
- **Where does XML-RPC failure surface?** Our `deliver` throws → openclaw catches it → fires our `onError` callback + increments `failedCounts.final` + the promise still resolves. Authoritative signal is our own callback bookkeeping.

## Still open (defer to implementation)

- Should the failed-bucket fallback chatter post itself be retried if it fails? (Currently spec says best-effort, log on failure.)
- Whether to expose backoff schedules as plugin config or keep them hardcoded.
