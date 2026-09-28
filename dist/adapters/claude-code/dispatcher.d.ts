import type { Harness, Mode, StateSnapshot } from "../../core/contracts.js";
import { type ClaudeSessionStore } from "./session.js";
import { type HookResponse } from "./types.js";
export interface ClaudeDispatcherOptions {
    readonly harness: Harness;
    readonly mode: Mode;
    /** Environment lookup; CLAUDE_PROJECT_DIR wins over the event's cwd. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly sessions?: ClaudeSessionStore;
    /** Canonical policy read for SessionStart/PreCompact; defaults to readProject. */
    readonly readState?: (projectRoot: string) => Promise<StateSnapshot | null>;
    /** Bound on injected policy text; default 3000 chars. */
    readonly policyCharLimit?: number;
}
/**
 * Dispatch one raw hook payload. Never throws: malformed input and internal errors
 * degrade to a pass-through, except PreToolUse in enforce mode, which denies.
 */
export declare function dispatchClaudeHook(rawInput: unknown, options: ClaudeDispatcherOptions): Promise<HookResponse>;
