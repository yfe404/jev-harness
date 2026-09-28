export interface ClaudeSessionStore {
    /** The request id of the most recently accepted user prompt, or null. */
    currentRequest(projectRoot: string, sessionId: string): Promise<string | null>;
    /** No-op for uninitialized projects; never creates .harness/ itself. */
    setCurrentRequest(projectRoot: string, sessionId: string, requestId: string): Promise<void>;
}
/** Derive a retry-stable request id: re-sent identical prompts map to the same request. */
export declare function requestIdForPrompt(sessionId: string, transcriptPath: string | undefined, prompt: string): string;
/** Deterministic fallback when no accepted prompt was recorded for the session. */
export declare function fallbackRequestId(sessionId: string): string;
export declare function createFileSessionStore(options?: {
    now?: () => Date;
}): ClaudeSessionStore;
/** In-memory store for tests and embedded dispatchers. */
export declare function createMemorySessionStore(): ClaudeSessionStore;
