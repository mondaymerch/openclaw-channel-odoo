/**
 * Per-key promise-chain mutex. Serializes async operations that share a key;
 * operations with different keys run concurrently.
 *
 * Why: webhook handlers for the same Odoo record (model:res_id) must
 * read-modify-write a shared on-disk batch file. Without serialization, two
 * concurrent handlers can read the same starting snapshot, then both write
 * back — the second write silently overwrites the first, losing a message.
 *
 * Single-process only. Multiple gateway processes against the same queue
 * directory would need a filesystem lock (out of scope; spec assumes single
 * gateway).
 */

export type RecordLock = {
  /**
   * Run `fn` exclusively for the given key. Returns whatever `fn` returns.
   * If `fn` throws, the rejection is propagated to the caller AND the chain
   * for this key continues normally for subsequent callers.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;

  /** Number of keys currently tracked. Test-only introspection. */
  size(): number;
};

export function createRecordLock(): RecordLock {
  const tails = new Map<string, Promise<unknown>>();

  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previousTail = tails.get(key) ?? Promise.resolve();

      // Chain regardless of whether previousTail fulfilled or rejected.
      const nextTail = previousTail.then(fn, fn);

      // A separate promise that swallows our own rejection — that's what we
      // store as the next tail, so future waiters never inherit our error.
      const swallowed = nextTail.catch(() => {});
      tails.set(key, swallowed);

      try {
        return await nextTail;
      } finally {
        if (tails.get(key) === swallowed) {
          tails.delete(key);
        }
      }
    },

    size() {
      return tails.size;
    },
  };
}
