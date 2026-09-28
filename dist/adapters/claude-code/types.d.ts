export interface ClaudeHookBase {
    readonly sessionId: string;
    readonly transcriptPath?: string;
    readonly cwd: string;
    readonly permissionMode?: string;
    /** Present only inside a subagent. */
    readonly agentId?: string;
}
export type ClaudeHookEventName = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "PreCompact" | "SessionStart";
export type ClaudeHookEvent = Readonly<{
    event: "UserPromptSubmit";
    base: ClaudeHookBase;
    prompt: string;
}> | Readonly<{
    event: "PreToolUse";
    base: ClaudeHookBase;
    toolName: string;
    toolInput: Readonly<Record<string, unknown>>;
    toolUseId: string;
}> | Readonly<{
    event: "PostToolUse";
    base: ClaudeHookBase;
    toolName: string;
    toolInput: Readonly<Record<string, unknown>>;
    toolUseId: string;
    toolResponse: unknown;
}> | Readonly<{
    event: "Stop";
    base: ClaudeHookBase;
    stopHookActive: boolean;
    lastAssistantMessage?: string;
}> | Readonly<{
    event: "PreCompact";
    base: ClaudeHookBase;
    trigger: string;
    customInstructions: string | null;
}> | Readonly<{
    event: "SessionStart";
    base: ClaudeHookBase;
    source: string;
    model?: string;
}>;
/** What the dispatcher produces; a thin CLI wrapper turns it into process output. */
export interface HookResponse {
    readonly exitCode: 0 | 2;
    readonly stdout: string;
    readonly stderr: string;
}
export declare const PASS: HookResponse;
export declare function jsonResponse(payload: unknown): HookResponse;
/** Lenient event-name extraction for error paths where full parsing failed. */
export declare function hookEventName(raw: unknown): ClaudeHookEventName | null;
/** Strictly parse one hook payload; throws with a safe message on malformed input. */
export declare function parseHookInput(raw: unknown): ClaudeHookEvent;
export type ToolIntent = "shell" | "read" | "write" | "edit" | "other";
export interface NormalizedTool {
    readonly toolName: string;
    readonly intent: ToolIntent;
    readonly input: Readonly<Record<string, unknown>>;
}
/**
 * Map Claude tool names/fields onto the core's normalized intents.
 * Claude uses file_path/old_string; the core expects path/oldText/newText.
 */
export declare function normalizeClaudeTool(toolName: string, input: Readonly<Record<string, unknown>>): NormalizedTool;
