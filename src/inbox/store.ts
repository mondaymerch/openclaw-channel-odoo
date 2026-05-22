/**
 * Persistent inbox — on-disk store.
 *
 * One file per debounce batch, keyed by `batchKey`. All mutations from
 * multiple call sites (webhook handler, dispatch, retry, recovery) must
 * happen under the per-record lock (`record-lock.ts`); this module is
 * lock-agnostic and only handles file ops.
 *
 * Atomicity is delegated to openclaw's `writeJsonFileAtomically` which does
 * tmp + fsync + rename + chmod 0o600. Stronger than the spec's "no fsync"
 * minimum; accepted as free durability.
 */

import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";

import type { InboxBatch, Timestamp } from "./types.js";

/**
 * Normalize a parsed batch from an older on-disk schema (with `dispatchedAt`)
 * into the current shape (with `closedAt` + `inFlightSince`).
 *
 * Idempotent — calling it on a current-shape batch is a no-op via the
 * `"closedAt" in b` guard.
 *
 * Disambiguation for legacy `state === "received" && dispatchedAt !== null`
 * (either the previous process crashed mid-dispatch, OR it recorded a failure
 * and was waiting for the retry timer): if `lastAttemptAt >= dispatchedAt`,
 * a failure was recorded after dispatch started → no longer in flight (treat
 * as "received in backoff"). Otherwise it was in flight at crash → flip to
 * the new `"dispatching"` state with `inFlightSince = legacy dispatchedAt`.
 */
function normalizeLegacyBatch(parsed: unknown): InboxBatch {
  const b = parsed as InboxBatch & { dispatchedAt?: Timestamp | null };
  // Backfill `routing_key` for batches written before that field existed.
  // Idempotent: leaves any existing value (incl. an explicit null) alone.
  if (!("routing_key" in (b as Record<string, unknown>))) {
    b.routing_key = null;
  }
  if ("closedAt" in b && b.closedAt !== undefined) {
    return b as InboxBatch; // already current shape
  }
  const legacy = b.dispatchedAt ?? null;
  delete (b as { dispatchedAt?: unknown }).dispatchedAt;
  b.closedAt = legacy;
  if (legacy === null) {
    b.inFlightSince = null;
  } else if (b.state === "reply_ready") {
    b.inFlightSince = null;
  } else if (b.state === "received") {
    if (b.lastAttemptAt !== null && b.lastAttemptAt >= legacy) {
      b.inFlightSince = null;
    } else {
      b.state = "dispatching";
      b.inFlightSince = legacy;
    }
  } else {
    b.inFlightSince = null;
  }
  return b;
}

// ---- Path resolution -----------------------------------------------------

export type InboxQueuePaths = {
  queueDir: string;
  failedDir: string;
};

const QUEUE_DIRNAME = "odoo-inbound-queue";
const FAILED_DIRNAME = "failed";
const ACTIVE_SUFFIX = ".json";
const TMP_SUFFIX = ".tmp";

/**
 * Mirror openclaw's own state-dir resolution so we share the same root
 * (`~/.openclaw` by default).
 *
 *   $OPENCLAW_STATE_DIR              → used directly
 *   else $OPENCLAW_HOME/.openclaw    → if OPENCLAW_HOME is set
 *   else ~/.openclaw
 */
export function resolveStateDir(): string {
  const direct = process.env.OPENCLAW_STATE_DIR;
  if (direct) return direct;
  const base = process.env.OPENCLAW_HOME ?? homedir();
  return join(base, ".openclaw");
}

export function resolveInboxQueuePaths(
  stateDir: string = resolveStateDir(),
): InboxQueuePaths {
  const queueDir = join(stateDir, QUEUE_DIRNAME);
  return { queueDir, failedDir: join(queueDir, FAILED_DIRNAME) };
}

export async function ensureInboxQueueDirs(paths: InboxQueuePaths): Promise<void> {
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.failedDir, { recursive: true });
}

/**
 * Defensively replace path-unsafe characters in an Odoo model name. In
 * practice Odoo models are dotted lowercase ("crm.lead") with nothing to
 * sanitize, but a misconfigured route shouldn't be able to escape the
 * queue dir.
 */
function sanitizeModel(model: string): string {
  return model.replace(/[/\\]/g, "_");
}

/**
 * Filename schema: `${sanitizedModel}__${res_id}__${batchKey}.json`.
 * The record-key prefix lets `findOpenBatchForRecord` narrow candidate
 * files in user-space (string match on readdir output) before reading any
 * file contents.
 */
function batchPath(
  queueDir: string,
  model: string,
  res_id: number,
  batchKey: string,
): string {
  return join(queueDir, `${sanitizeModel(model)}__${res_id}__${batchKey}${ACTIVE_SUFFIX}`);
}

function failedBatchPath(
  failedDir: string,
  model: string,
  res_id: number,
  batchKey: string,
): string {
  return join(failedDir, `${sanitizeModel(model)}__${res_id}__${batchKey}${ACTIVE_SUFFIX}`);
}

/**
 * Resolve a `batchKey` to its exact filename in the given directory by
 * scanning for any file ending in `__<batchKey>.json`. Used by lookup-by-key
 * paths that don't already have model/res_id in hand (e.g. retry scheduler
 * firing). Returns null on ENOENT or no match.
 */
async function locateBatchFile(dir: string, batchKey: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
  const suffix = `__${batchKey}${ACTIVE_SUFFIX}`;
  const match = names.find(
    (n) => n.endsWith(suffix) && !n.endsWith(TMP_SUFFIX),
  );
  return match ? join(dir, match) : null;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

// ---- Core CRUD -----------------------------------------------------------

/** Returns null if the file is missing; throws on parse / other I/O errors. */
export async function readBatch(
  paths: InboxQueuePaths,
  batchKey: string,
): Promise<InboxBatch | null> {
  const filePath = await locateBatchFile(paths.queueDir, batchKey);
  if (!filePath) return null;
  return readBatchFromFile(filePath);
}

async function readBatchFromFile(filePath: string): Promise<InboxBatch | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
  return normalizeLegacyBatch(JSON.parse(raw));
}

/**
 * Atomic write via openclaw's `writeJsonFileAtomically` (tmp + fsync +
 * rename + chmod 0o600). Crash-safe across process death AND power loss.
 *
 * Callers MUST hold the per-record lock (`record-lock.ts`) when this write
 * races with concurrent webhook handlers on the same `(model, res_id)`.
 */
export async function writeBatch(
  paths: InboxQueuePaths,
  batch: InboxBatch,
): Promise<void> {
  await writeJsonFileAtomically(
    batchPath(paths.queueDir, batch.model, batch.res_id, batch.batchKey),
    batch,
  );
}

/** ENOENT-safe; intentional no-op if the file is already gone. */
export async function unlinkBatch(
  paths: InboxQueuePaths,
  batchKey: string,
): Promise<void> {
  const filePath = await locateBatchFile(paths.queueDir, batchKey);
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}

/**
 * Rename from queueDir → failedDir. Atomic per POSIX (both dirs share the
 * same filesystem — failedDir is a subdir of queueDir). ENOENT-safe.
 *
 * We read the batch first to recover its `model` + `res_id`, which are
 * needed to compute the destination filename. Cheaper than parsing the
 * filename itself, and we're about to rename it anyway.
 */
export async function moveBatchToFailed(
  paths: InboxQueuePaths,
  batchKey: string,
): Promise<void> {
  const srcFile = await locateBatchFile(paths.queueDir, batchKey);
  if (!srcFile) return;
  let batch: InboxBatch;
  try {
    const raw = await readFile(srcFile, "utf8");
    batch = normalizeLegacyBatch(JSON.parse(raw));
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
  try {
    await rename(
      srcFile,
      failedBatchPath(paths.failedDir, batch.model, batch.res_id, batch.batchKey),
    );
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}

// ---- Scan ----------------------------------------------------------------

export type ListBatchesOpts = {
  /** Called for files that exist but fail to parse. Scan continues. */
  onCorrupt?: (file: string, err: unknown) => void;
};

/** Lists all batches in queueDir. Skips tmp files and the failed/ subdir. */
export async function listBatches(
  paths: InboxQueuePaths,
  opts: ListBatchesOpts = {},
): Promise<InboxBatch[]> {
  return listBatchesInDir(paths.queueDir, opts);
}

async function listBatchesInDir(
  dir: string,
  opts: ListBatchesOpts,
): Promise<InboxBatch[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return [];
    throw err;
  }
  const out: InboxBatch[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;                       // skip subdirs (failed/)
    if (!dirent.name.endsWith(ACTIVE_SUFFIX)) continue;   // skip non-json
    if (dirent.name.endsWith(TMP_SUFFIX)) continue;       // belt-and-suspenders
    const full = join(dir, dirent.name);
    try {
      const raw = await readFile(full, "utf8");
      out.push(normalizeLegacyBatch(JSON.parse(raw)));
    } catch (err) {
      opts.onCorrupt?.(full, err);
    }
  }
  return out;
}

/**
 * Walk both queueDir and failedDir; return the first batch whose `messages`
 * array contains a message with the given `message_id`, or null.
 *
 * Used by webhook dedup on `dedupeCache` miss. Worst-case O(K·M) parses
 * where K is batch count and M is messages per batch. Realistic numbers
 * (K ≤ 100, M ≤ 5) keep this sub-millisecond. If profiling later shows it
 * matters, build an in-memory `Map<message_id, batchKey>` at boot recovery.
 */
export async function findBatchContainingMessage(
  paths: InboxQueuePaths,
  messageId: number,
  opts: ListBatchesOpts = {},
): Promise<InboxBatch | null> {
  const active = await listBatchesInDir(paths.queueDir, opts);
  for (const b of active) {
    if (b.messages.some((m) => m.message_id === messageId)) return b;
  }
  const failed = await listBatchesInDir(paths.failedDir, opts);
  for (const b of failed) {
    if (b.messages.some((m) => m.message_id === messageId)) return b;
  }
  return null;
}

// ---- Composer ------------------------------------------------------------

/**
 * Read → apply `mutator` synchronously → atomic write back. Returns the
 * mutated batch, or null if the file was missing (no-op).
 *
 * Callers MUST hold the per-record lock (`record-lock.ts`) for the duration
 * of this call when racing with concurrent webhook handlers on the same
 * `(model, res_id)`. Without the lock, two concurrent `mutateBatch` calls
 * can read the same snapshot and clobber each other on write.
 */
export async function mutateBatch(
  paths: InboxQueuePaths,
  batchKey: string,
  mutator: (batch: InboxBatch) => void,
): Promise<InboxBatch | null> {
  const batch = await readBatch(paths, batchKey);
  if (!batch) return null;
  mutator(batch);
  await writeBatch(paths, batch);
  return batch;
}

// ---- Open-batch lookup ---------------------------------------------------

/**
 * Find the currently-open batch for the given record, or null if none.
 * "Open" = `state === "received"`.
 *
 * A batch in `state === "received"` is appendable: either it's a freshly
 * created batch (no dispatch attempted yet) OR it's a previously-dispatched
 * batch that failed and got flipped back by `recordFailure`, sitting in
 * backoff awaiting retry. In both cases, a new inbound message should
 * append to it (not create a parallel batch).
 *
 * Uses the filename prefix (`${sanitizedModel}__${res_id}__`) to narrow
 * candidate files in user-space before touching the filesystem for reads.
 * Realistic candidate count: 0-2 (an in-flight batch + maybe a brand-new
 * one), so this typically reads at most a couple of files.
 *
 * Callers should hold `withLock(${model}:${res_id})` for the duration of
 * the append-or-create sequence around this call. Without the lock, two
 * concurrent webhooks could both observe "no open batch" and create
 * separate batches for the same record.
 *
 * Per-file corruption is swallowed silently — boot recovery's `listBatches`
 * with `onCorrupt` is where bad files get reported, not the webhook hot
 * path.
 */
export async function findOpenBatchForRecord(
  paths: InboxQueuePaths,
  model: string,
  res_id: number,
  routing_key: string | null,
): Promise<InboxBatch | null> {
  const prefix = `${sanitizeModel(model)}__${res_id}__`;
  let names: string[];
  try {
    names = await readdir(paths.queueDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith(ACTIVE_SUFFIX)) continue;
    if (name.endsWith(TMP_SUFFIX)) continue;
    try {
      const raw = await readFile(join(paths.queueDir, name), "utf8");
      const batch = normalizeLegacyBatch(JSON.parse(raw));
      if (batch.state === "received" && batch.routing_key === routing_key) {
        return batch;
      }
    } catch {
      // intentionally silent — see JSDoc
    }
  }
  return null;
}
