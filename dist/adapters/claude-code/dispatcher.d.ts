import type { Harness, Mode, RuntimeService, StateSnapshot } from "../../core/contracts.js";
import { type ClaudeSessionStore } from "./session.js";
import { type HookResponse } from "./types.js";
export interface ClaudeDispatcherOptions {
    readonly harness: Harness;
    readonly mode: Mode;
    /** Environment lookup; CLAUDE_PROJECT_DIR wins over the event's cwd. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly sessions?: ClaudeSessionStore;
    /** Freeze service for the fail-closed hold; defaults to the file service. */
    readonly runtime?: RuntimeService;
    /** Canonical policy read for SessionStart; defaults to readProject. */
    readonly readState?: (projectRoot: string) => Promise<StateSnapshot | null>;
    /** Bound on injected policy text; default 3000 chars. Oldest entries are
     * dropped first and the omission is stated, never silently truncated. */
    readonly policyCharLimit?: number;
}
/**
 * The canonical policy block (goal + standing rules + preserved key decisions),
 * shared with the compaction validator so every surface injects the same text.
 * Over the limit, the oldest standing rules are dropped first and the omission
 * is stated on the marker line; the goal and the newest entries are kept.
 */
export declare function formatPolicy(state: StateSnapshot, limit: number): string;
/**
 * Dispatch one raw hook payload. Never throws. Failure policy:
 * - Payload whose hook event cannot be established at all (not JSON, no known
 *   hook_event_name): exit 2 with a generic stderr line, never echoing the
 *   input — fail closed, because an unparseable PreToolUse must not pass.
 * - Malformed or unevaluable PreToolUse: deny JSON plus exit 2, in every mode
 *   (shadow never applies a gate verdict, but an input no gate could evaluate
 *   is not a verdict).
 * - Other malformed events and internal errors on non-PreToolUse events:
 *   pass-through, because those events cannot block anything meaningful and an
 *   exit 2 there would erase the user's prompt or force more agent work.
 */
export declare function dispatchClaudeHook(rawInput: unknown, options: ClaudeDispatcherOptions): Promise<HookResponse>;
