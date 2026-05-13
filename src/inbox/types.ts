export type InboundMessage = {                                                                               
  message_id: number;                                  
  body: string;                             
  user_name?: string;        // optional — webhook may omit
  partner_id?: number;       // optional — webhook may omit
  receivedAt: Timestamp;     // when THIS message's webhook arrived                                          
};                                      
                                                                                                               
export type InboxBatch = {
  batchKey: string;          // UUID; matches the filename
  state: MessageState;
  model: string;
  res_id: number;
  messages: InboundMessage[];

  enqueuedAt: Timestamp;     // when the batch was OPENED (first message arrived)

  /** Set ONCE on the first markDispatching call; never cleared, never
   *  overwritten. Answers "has any dispatch attempt ever started?" — used
   *  by diagnostics / future readers. */
  closedAt: Timestamp | null;

  /** Set by markDispatching on every dispatch start (overwritten on retry).
   *  Cleared by recordFailure and transitionToReplyReady.
   *  Non-null ⇔ state === "dispatching". Used by boot recovery to detect
   *  whether the previous process was mid-dispatch at crash. */
  inFlightSince: Timestamp | null;

  dispatchAttempts: number;
  deliveryAttempts: number;
  lastAttemptAt: Timestamp | null;
  lastError: string | null;
  lastFailureClass: FailureClass | null;
  reply: Reply | null;       // one reply per batch
};                                                                                                           
                                                         
export type Reply = {                                                                                        
  text: string;
  producedAt: Timestamp;                                                                                     
};

export type Timestamp = number;
export type FailureClass = "silent" | "internal_error" | "xmlrpc_failure";
export type MessageState = "received" | "dispatching" | "reply_ready";

export const REPLAY_TTL_MS: number = 60 * 60 * 1000;         // 1h
export const HARD_TIMEOUT_MS: number = 15 * 60 * 1000;       // 15min
export const AGENT_RUN_TIMEOUT_MS: number = HARD_TIMEOUT_MS;

/** Spacing between immediately-eligible `received` batches at boot
 *  recovery. Flat 200ms — prevents dogpiling the agent concurrency lane
 *  when many batches were left on disk by the previous gateway. */
export const REPLAY_STAGGER_MS: number = 200;

/**
 * Retry caps + backoff schedules.
 *
 * Indexing convention: after `recordFailure` bumps the counter, the
 * just-incremented value is 1-indexed. For the Nth failure, the next retry
 * uses `backoff[counter - 1]`. When `counter >= MAX`, abandon — array length
 * is therefore `MAX - 1`.
 */

/** Max total attempts for silent/internal_error before moving the batch
 *  to failed/. Counter = `dispatchAttempts`. */
export const DISPATCH_MAX_ATTEMPTS = 3;

/** Max total attempts for xmlrpc_failure. Counter = `deliveryAttempts`. */
export const DELIVERY_MAX_ATTEMPTS = 5;

/** Backoff in ms between retries for silent/internal_error. */
export const DISPATCH_BACKOFF_MS: readonly number[] = [30_000, 120_000];

/** Backoff in ms between retries for xmlrpc_failure. */
export const DELIVERY_BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];
