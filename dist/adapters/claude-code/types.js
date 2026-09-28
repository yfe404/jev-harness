// Untrusted stdin parsing for Claude Code hook events.
// Field sets match the documented Claude Code hook contract; unknown extra fields are ignored.
export const PASS = { exitCode: 0, stdout: "", stderr: "" };
export function jsonResponse(payload) {
    return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
    return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
/** Lenient event-name extraction for error paths where full parsing failed. */
export function hookEventName(raw) {
    if (!record(raw))
        return null;
    const name = raw.hook_event_name;
    return name === "UserPromptSubmit" || name === "PreToolUse" || name === "PostToolUse" ||
        name === "Stop" || name === "PreCompact" || name === "SessionStart" ? name : null;
}
function base(raw) {
    if (!text(raw.session_id))
        throw new Error("Hook input is missing session_id");
    if (!text(raw.cwd))
        throw new Error("Hook input is missing cwd");
    return {
        sessionId: raw.session_id,
        cwd: raw.cwd,
        ...(text(raw.transcript_path) ? { transcriptPath: raw.transcript_path } : {}),
        ...(text(raw.permission_mode) ? { permissionMode: raw.permission_mode } : {}),
        ...(text(raw.agent_id) ? { agentId: raw.agent_id } : {}),
    };
}
/** Strictly parse one hook payload; throws with a safe message on malformed input. */
export function parseHookInput(raw) {
    if (!record(raw))
        throw new Error("Hook input is not a JSON object");
    const name = hookEventName(raw);
    if (!name)
        throw new Error("Hook input has an unknown hook_event_name");
    const shared = base(raw);
    switch (name) {
        case "UserPromptSubmit":
            return { event: name, base: shared, prompt: typeof raw.prompt === "string" ? raw.prompt : "" };
        case "PreToolUse": {
            if (!text(raw.tool_name))
                throw new Error("PreToolUse input is missing tool_name");
            return {
                event: name, base: shared, toolName: raw.tool_name,
                toolInput: record(raw.tool_input) ? raw.tool_input : {},
                toolUseId: text(raw.tool_use_id) ? raw.tool_use_id : "unknown",
            };
        }
        case "PostToolUse": {
            if (!text(raw.tool_name))
                throw new Error("PostToolUse input is missing tool_name");
            return {
                event: name, base: shared, toolName: raw.tool_name,
                toolInput: record(raw.tool_input) ? raw.tool_input : {},
                toolUseId: text(raw.tool_use_id) ? raw.tool_use_id : "unknown",
                toolResponse: raw.tool_response,
            };
        }
        case "Stop":
            return {
                event: name, base: shared, stopHookActive: raw.stop_hook_active === true,
                ...(typeof raw.last_assistant_message === "string" ? { lastAssistantMessage: raw.last_assistant_message } : {}),
            };
        case "PreCompact":
            return {
                event: name, base: shared,
                trigger: typeof raw.trigger === "string" ? raw.trigger : "unknown",
                customInstructions: typeof raw.custom_instructions === "string" ? raw.custom_instructions : null,
            };
        case "SessionStart":
            return {
                event: name, base: shared,
                source: typeof raw.source === "string" ? raw.source : "startup",
                ...(typeof raw.model === "string" ? { model: raw.model } : {}),
            };
    }
}
/**
 * Map Claude tool names/fields onto the core's normalized intents.
 * Claude uses file_path/old_string; the core expects path/oldText/newText.
 */
export function normalizeClaudeTool(toolName, input) {
    switch (toolName) {
        case "Bash":
        case "PowerShell":
            return { toolName, intent: "shell", input };
        case "Write":
            return { toolName, intent: "write", input: { ...input, path: input.file_path } };
        case "Edit":
            return { toolName, intent: "edit",
                input: { ...input, path: input.file_path, oldText: input.old_string, newText: input.new_string } };
        case "MultiEdit":
            return {
                toolName, intent: "edit",
                input: {
                    ...input, path: input.file_path,
                    edits: Array.isArray(input.edits)
                        ? input.edits.map(item => record(item)
                            ? { ...item, oldText: item.old_string, newText: item.new_string }
                            : item)
                        : input.edits,
                },
            };
        case "NotebookEdit":
            return { toolName, intent: "edit", input: { ...input, path: input.notebook_path } };
        case "Read":
            return { toolName, intent: "read", input: { ...input, path: input.file_path } };
        case "Glob":
        case "Grep":
        case "LS":
            return { toolName, intent: "read", input };
        default:
            // WebFetch, WebSearch, Agent/Task, TodoWrite, Skill, mcp__*, and future tools:
            // the core escalates unmodeled capabilities in enforce mode instead of silently passing.
            return { toolName, intent: "other", input };
    }
}
