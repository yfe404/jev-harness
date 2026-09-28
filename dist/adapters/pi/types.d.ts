import type { ToolPreflightEvent } from "../../core/contracts.js";
export interface PiMessageLike {
    readonly role?: string;
    readonly customType?: string;
    readonly content?: unknown;
    readonly details?: unknown;
    readonly [key: string]: unknown;
}
/** Pi `input` event. source: "interactive" | "rpc" | "extension". */
export interface PiInputEvent {
    readonly text?: string;
    readonly source?: string;
    /** Set for mid-run steering/follow-up input; undefined when the agent is idle. */
    readonly streamingBehavior?: "steer" | "followUp";
}
/** Pi `context` event: a deep copy of the outgoing messages. */
export interface PiContextEvent {
    readonly messages: PiMessageLike[];
}
export interface PiToolCallEvent {
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly input?: Record<string, unknown>;
}
export interface PiToolResultContent {
    readonly type?: string;
    readonly text?: string;
    readonly [key: string]: unknown;
}
export interface PiToolResultEvent {
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly input?: Record<string, unknown>;
    readonly content?: readonly PiToolResultContent[];
    readonly isError?: boolean;
}
/** Minimal shape of a session entry the adapter inspects (compaction and custom entries). */
export interface PiSessionEntryLike {
    readonly type?: string;
    readonly id?: string;
    readonly summary?: string;
    readonly details?: unknown;
    readonly customType?: string;
    readonly data?: unknown;
}
/** Pi `before_agent_start` event: the prompt was accepted and the run starts now. */
export interface PiBeforeAgentStartEvent {
    readonly prompt?: string;
}
/** Pi `session_compact` event. */
export interface PiSessionCompactEvent {
    readonly compactionEntry?: PiSessionEntryLike;
    readonly fromExtension?: boolean;
    readonly reason?: string;
}
export interface PiSessionManagerLike {
    getSessionId(): string;
    getBranch(): readonly PiSessionEntryLike[];
}
export interface PiUiLike {
    notify(message: string, type: "info" | "warning" | "error"): void;
    confirm?(title: string, message: string): Promise<boolean>;
    setStatus?(key: string, value?: string): void;
}
export interface PiExtensionContext {
    readonly cwd: string;
    readonly mode: string;
    readonly hasUI: boolean;
    isProjectTrusted(): boolean;
    readonly sessionManager: PiSessionManagerLike;
    readonly ui: PiUiLike;
    readonly signal?: AbortSignal;
}
export interface PiToolCallResult {
    readonly block?: boolean;
    readonly terminate?: boolean;
    readonly reason?: string;
}
export interface PiToolResultPatch {
    readonly content?: readonly PiToolResultContent[];
    readonly isError?: boolean;
}
export interface PiCommandContext extends PiExtensionContext {
}
export interface PiToolDefinition {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly promptSnippet?: string;
    readonly promptGuidelines?: readonly string[];
    /** Plain JSON Schema object; structurally compatible with typebox schemas. */
    readonly parameters: Readonly<Record<string, unknown>>;
    execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiExtensionContext): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        details?: unknown;
    }>;
}
export interface PiExtensionApi {
    on(event: string, handler: (event: never, ctx: PiExtensionContext) => unknown): void;
    registerTool(definition: PiToolDefinition): void;
    registerCommand?(name: string, definition: {
        description: string;
        handler(args: string, ctx: PiCommandContext): unknown;
    }): void;
    getActiveTools?(): readonly string[];
    appendEntry?(customType: string, data?: unknown): void;
}
export type ToolIntent = ToolPreflightEvent["intent"];
/** Maps Pi tool names onto the harness tool intents; everything else escalates. */
export declare function intentForTool(toolName: string): ToolIntent;
/** Concatenates the text parts of a Pi tool result into one screening string. */
export declare function contentText(content: readonly PiToolResultContent[] | undefined): string;
export declare const oneLine: (text: string) => string;
