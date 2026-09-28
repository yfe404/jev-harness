import { readProject } from "../../core/state/files.js";
import { redactText } from "../../core/redact.js";
import { fallbackRequestId, requestIdForPrompt, createFileSessionStore, } from "./session.js";
import { PASS, hookEventName, jsonResponse, normalizeClaudeTool, parseHookInput, } from "./types.js";
const REASON_LIMIT = 1800;
const cap = (text, limit = REASON_LIMIT) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const oneLine = (text) => cap(text.replace(/\s*\n\s*/g, " ⏎ "));
function projectRoot(base, env) {
    const fromEnv = env?.CLAUDE_PROJECT_DIR;
    return typeof fromEnv === "string" && fromEnv.length > 0 && !fromEnv.includes("\0") ? fromEnv : base.cwd;
}
function context(base, root, requestId) {
    // Hooks only run for workspaces Claude itself trusts; project initialization
    // (.harness/) is the opt-in gate and uninitialized projects stay inert in the core.
    return { host: "claude-code", projectRoot: root, sessionId: base.sessionId, requestId, trusted: true };
}
function deny(reason) {
    return jsonResponse({
        hookSpecificOutput: {
            hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: oneLine(reason),
        },
    });
}
function advisory(event, message) {
    return jsonResponse({ hookSpecificOutput: { hookEventName: event, additionalContext: cap(message, 3000) } });
}
/** Interactive permission modes can ask the owner; anything else must deny on escalation. */
function canAsk(permissionMode) {
    return permissionMode === undefined || permissionMode === "default" ||
        permissionMode === "acceptEdits" || permissionMode === "plan";
}
function preflightResponse(decision, permissionMode) {
    switch (decision.appliedAction) {
        case "block":
        case "halt":
        case "freeze":
            return deny(decision.reason);
        case "escalate":
        case "confirm":
            if (canAsk(permissionMode)) {
                return jsonResponse({
                    hookSpecificOutput: {
                        hookEventName: "PreToolUse", permissionDecision: "ask",
                        permissionDecisionReason: oneLine(decision.reason),
                    },
                });
            }
            return deny(`Owner confirmation required but this session cannot prompt: ${oneLine(decision.reason)}`);
        default:
            // allow / none / capture / remind / redact / replan: nothing to enforce pre-execution.
            return PASS;
    }
}
function formatPolicy(state, limit) {
    const lines = [];
    const goal = redactText(state.goal.trim());
    if (goal)
        lines.push(`Goal: ${goal}`);
    if (state.constraints.length) {
        lines.push("Standing rules (.harness/constraints.md):");
        for (const rule of state.constraints)
            lines.push(`- ${rule.id} (${rule.createdAt}): ${redactText(rule.text)}`);
    }
    let text = lines.join("\n");
    if (text.length > limit)
        text = `${text.slice(0, limit - 60)}\n… (truncated; see .harness/constraints.md)`;
    return text;
}
async function policyState(options, root) {
    try {
        return await (options.readState ?? readProject)(root);
    }
    catch {
        return null;
    }
}
async function handleUserPrompt(event, options, sessions) {
    const root = projectRoot(event.base, options.env);
    const requestId = requestIdForPrompt(event.base.sessionId, event.base.transcriptPath, event.prompt);
    await sessions.setCurrentRequest(root, event.base.sessionId, requestId);
    const ctx = context(event.base, root, requestId);
    const transition = await options.harness.acceptUserRequest({ context: ctx, source: "user", accepted: true });
    // A retried prompt event is not fresh: skip capture/correction detection so a
    // retry cannot double-capture or release/resurrect a freeze.
    if (!transition.fresh || transition.decision.status !== "ready")
        return PASS;
    const decision = await options.harness.onUserInput({ context: ctx, text: event.prompt, source: "user" });
    if (decision.appliedAction === "freeze") {
        return advisory("UserPromptSubmit", "[jev-harness] Tool use is paused for this request. Reply in text only: acknowledge the correction, explain what you did and why, then wait for the next user message.");
    }
    if (decision.appliedAction === "capture" && decision.recordedId) {
        return advisory("UserPromptSubmit", `[jev-harness] Recorded standing rule ${decision.recordedId}. It will be enforced on plans, commands, and file changes in this project.`);
    }
    if (decision.appliedAction === "escalate") {
        return advisory("UserPromptSubmit", `[jev-harness] ${oneLine(decision.reason)}`);
    }
    return PASS;
}
async function handlePreToolUse(event, options, sessions) {
    const root = projectRoot(event.base, options.env);
    const requestId = await sessions.currentRequest(root, event.base.sessionId) ?? fallbackRequestId(event.base.sessionId);
    const tool = normalizeClaudeTool(event.toolName, event.toolInput);
    const decision = await options.harness.onToolPreflight({
        context: context(event.base, root, requestId),
        callId: event.toolUseId, toolName: tool.toolName, intent: tool.intent, input: tool.input,
    });
    return preflightResponse(decision, event.base.permissionMode);
}
async function handlePostToolUse(event, options, sessions) {
    const root = projectRoot(event.base, options.env);
    const requestId = await sessions.currentRequest(root, event.base.sessionId) ?? fallbackRequestId(event.base.sessionId);
    const tool = normalizeClaudeTool(event.toolName, event.toolInput);
    // Built-in tool output cannot be replaced through PostToolUse; screening is advisory.
    const result = await options.harness.onToolResult({
        context: context(event.base, root, requestId),
        callId: event.toolUseId, toolName: tool.toolName, intent: tool.intent, input: tool.input,
        output: event.toolResponse,
        isError: !!event.toolResponse && typeof event.toolResponse === "object" &&
            !Array.isArray(event.toolResponse) && "error" in event.toolResponse &&
            !!event.toolResponse.error,
        canReplaceOutput: false,
    });
    const decision = result.decision;
    if (decision.appliedAction === "remind" || decision.appliedAction === "redact" || decision.appliedAction === "escalate") {
        return advisory("PostToolUse", `[jev-harness] ${oneLine(decision.reason)}`);
    }
    return PASS;
}
async function handlePreCompact(event, options) {
    // Plain text only: stdout is appended verbatim to the native summary's custom
    // instructions. This hook cannot see, veto, or replace that summary.
    const root = projectRoot(event.base, options.env);
    const state = await policyState(options, root);
    if (!state)
        return PASS;
    const policy = formatPolicy(state, options.policyCharLimit ?? 3000);
    if (!policy)
        return PASS;
    return {
        exitCode: 0,
        stdout: `Preserve the project goal and every standing rule below verbatim in the summary:\n${policy}\n`,
        stderr: "",
    };
}
async function handleSessionStart(event, options) {
    // Restore canonical policy after compact/clear/resume/startup, independently of
    // whatever the native summary kept. Bounded, redacted, advisory context.
    const root = projectRoot(event.base, options.env);
    const state = await policyState(options, root);
    if (!state)
        return PASS;
    const policy = formatPolicy(state, options.policyCharLimit ?? 3000);
    if (!policy)
        return PASS;
    return advisory("SessionStart", `[jev-harness] Current project policy (authoritative, from .harness/):\n${policy}`);
}
async function handle(event, options) {
    const sessions = options.sessions ?? createFileSessionStore();
    switch (event.event) {
        case "UserPromptSubmit": return handleUserPrompt(event, options, sessions);
        case "PreToolUse": return handlePreToolUse(event, options, sessions);
        case "PostToolUse": return handlePostToolUse(event, options, sessions);
        case "PreCompact": return handlePreCompact(event, options);
        case "SessionStart": return handleSessionStart(event, options);
        case "Stop":
            // Never clear a freeze, never block (a block forces more agent work, and
            // stop_hook_active loops). Automatic claim checks on Stop are not supported;
            // use the explicit claim-check path instead.
            return PASS;
    }
}
/**
 * Dispatch one raw hook payload. Never throws: malformed input and internal errors
 * degrade to a pass-through, except PreToolUse in enforce mode, which denies.
 */
export async function dispatchClaudeHook(rawInput, options) {
    let parsed;
    try {
        parsed = parseHookInput(rawInput);
    }
    catch {
        return hookEventName(rawInput) === "PreToolUse" && options.mode === "enforce"
            ? deny("jev-harness could not parse this tool call; blocked in enforce mode")
            : PASS;
    }
    try {
        return await handle(parsed, options);
    }
    catch (error) {
        if (parsed.event === "PreToolUse" && options.mode === "enforce") {
            const message = error instanceof Error ? error.message.replace(/[\n\r\0]+/g, " ").slice(0, 200) : "unknown error";
            return deny(`jev-harness internal error; blocked in enforce mode: ${message}`);
        }
        return PASS;
    }
}
