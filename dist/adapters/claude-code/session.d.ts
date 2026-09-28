export interface ClaudeSessionStore {
    /** The request id of the most recently accepted user prompt, or null. */
    currentRequest(projectRoot: string, sessionId: string): Promise<string | null>;
    /** No-op for uninitialized projects; never creates .harness/ itself. */
    setCurrentRequest(projectRoot: string, sessionId: string, requestId: string): Promise<void>;
}
/**
 * Best-effort stable identity of the current transcript boundary: the `uuid`
 * of the last transcript entry, read synchronously from the tail of the file.
 * The official hook documentation notes the transcript is written
 * asynchronously and may lag the current turn, and does not specify whether a
 * failed hook execution is ever retried — so this is a dedup hint, not a
 * guarantee. Returns undefined when no usable boundary exists.
 */
export declare function transcriptBoundary(transcriptPath: string | undefined): string | undefined;
/**
 * Derive the request id for one accepted prompt delivery. Two separately
 * accepted prompts with identical text are distinct requests and must not
 * reuse an old id (a repeated prompt after a correction is a new request, not
 * a retry), so each delivery mixes in a per-delivery discriminator:
 * an explicit `delivery` value (tests), else the current transcript boundary,
 * else fresh entropy. A redelivered hook payload observed at the same
 * transcript boundary dedupes to the same id and is treated as a retry, so a
 * duplicate delivery cannot release a later request's freeze; core
 * idempotency dedupes any repeated acceptance of the same id. Without a
 * transcript boundary there is no way to distinguish a redelivery from a
 * genuinely re-sent prompt — that limit is documented in docs/claude-code.md.
 */
export declare function requestIdForPrompt(sessionId: string, transcriptPath: string | undefined, prompt: string, delivery?: string): string;
/** Deterministic fallback when no accepted prompt was recorded for the session. */
export declare function fallbackRequestId(sessionId: string): string;
export declare function createFileSessionStore(options?: {
    now?: () => Date;
}): ClaudeSessionStore;
/** In-memory store for tests and embedded dispatchers. */
export declare function createMemorySessionStore(): ClaudeSessionStore;
