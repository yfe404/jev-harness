import { buildRetainedPolicyBlock } from "../../core/compaction.js";
import { redactText } from "../../core/redact.js";
import { readProject } from "../../core/state/files.js";
import { createFileRuntimeService } from "../../core/state/locks.js";
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
/**
 * Deny through exit 2, the supported blocking channel for error paths: per the
 * official hook contract, exit 2 blocks PreToolUse even without parseable JSON,
 * while exit 1 is a non-blocking error that lets the action proceed. The deny
 * JSON is still read and names the reason.
 */
function denyBlocking(reason) {
    const response = deny(reason);
    return { ...response, exitCode: 2 };
}
function advisory(event, message) {
    return jsonResponse({ hookSpecificOutput: { hookEventName: event, additionalContext: cap(message, 3000) } });
}
/**
 * Reject the current UserPromptSubmit through exit 2, the supported blocking
 * channel: per the official hook contract, exit 2 there blocks prompt
 * processing and shows stderr to the user (nothing is added to context). Used
 * only when enforcement is unavailable AND the fail-closed hold could not be
 * persisted — an accepted request must not proceed unclassified and unheld.
 */
function blockPrompt(reason) {
    return { exitCode: 2, stdout: "", stderr: `${oneLine(reason)}\n` };
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
/**
 * The canonical policy block (goal + standing rules + preserved key decisions),
 * shared with the compaction validator so every surface injects the same text.
 * Over the limit, the oldest standing rules are dropped first and the omission
 * is stated on the marker line; the goal and the newest entries are kept.
 */
export function formatPolicy(state, limit) {
    const redacted = buildRetainedPolicyBlock(state).split("\n").map(line => redactText(line));
    const text = redacted.join("\n");
    if (text.length <= limit)
        return text;
    const header = redacted.slice(0, 2); // banner + goal
    const entries = redacted.slice(2);
    const kept = [];
    let budget = limit - header.join("\n").length - 80;
    for (let i = entries.length - 1; i >= 0 && budget > 0; i--) {
        if (entries[i].length > budget)
            break;
        kept.unshift(entries[i]);
        budget -= entries[i].length + 1;
    }
    const omitted = entries.length - kept.length;
    return [...header, `… (${omitted} older entries omitted; full policy in .harness/goal.md and .harness/constraints.md)`, ...kept].join("\n");
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
    if (options.mode === "enforce" && (decision.status === "unavailable" || decision.status === "escalation")) {
        // Fail closed: the request was already accepted (which may have released a
        // prior freeze) but its classification did not succeed, so tool use must
        // not proceed on an unclassified request. Re-establish the hold against
        // the new request; only a later accepted and successfully classified
        // request (or an explicit owner reset) releases it.
        const runtime = options.runtime ?? createFileRuntimeService();
        let holdPersisted = true;
        try {
            await runtime.freeze(ctx);
        }
        catch {
            holdPersisted = false;
        }
        if (!holdPersisted) {
            // A failed lock write leaves nothing for the next preflight to read, so
            // the request would run unclassified and unheld — and enforcement
            // unavailable is never approval. Reject the submission with exit 2 (the
            // supported UserPromptSubmit blocking channel) instead of an advisory
            // that lets the agent start; never claim a hold that does not exist.
            return blockPrompt(`[jev-harness] This request could not be classified (${oneLine(decision.reason)}) and the fail-closed hold could not be persisted, so tool use is NOT durably held. The submission was rejected to prevent work on an unclassified request: inspect .harness/runtime/ for the failed write, then re-send the request, or run \`jh mode shadow\` to lift enforcement explicitly.`);
        }
        return advisory("UserPromptSubmit", `[jev-harness] This request could not be classified (${oneLine(decision.reason)}). Tool use stays on hold in enforce mode. Reply in text only; the owner may restate the request, or run \`jh mode shadow\` to lift enforcement.`);
    }
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
function handlePreCompact() {
    // Pass-through. Per the official hook contract, PreCompact stdout is not
    // added to Claude's context and cannot edit the native summary's
    // instructions; printing "preserve these rules" text here would claim a
    // protection that does not exist. Policy survives compaction because
    // SessionStart (source=compact) re-injects the canonical block afterwards.
    return PASS;
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
        case "PreCompact": return handlePreCompact();
        case "SessionStart": return handleSessionStart(event, options);
        case "Stop":
            // Never clear a freeze, never block (a block forces more agent work, and
            // stop_hook_active loops). Automatic claim checks on Stop are not supported;
            // use the explicit claim-check path instead.
            return PASS;
    }
}
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
export async function dispatchClaudeHook(rawInput, options) {
    let parsed;
    try {
        parsed = parseHookInput(rawInput);
    }
    catch {
        const name = hookEventName(rawInput);
        if (name === "PreToolUse")
            return denyBlocking("jev-harness could not parse this tool call; denied because the gate could not evaluate it");
        if (name === null)
            return { exitCode: 2, stdout: "", stderr: "jev-harness: malformed hook input; the hook event could not be established\n" };
        return PASS;
    }
    try {
        return await handle(parsed, options);
    }
    catch (error) {
        if (parsed.event === "PreToolUse") {
            const message = error instanceof Error ? error.message.replace(/[\n\r\0]+/g, " ").slice(0, 200) : "unknown error";
            return denyBlocking(`jev-harness internal error; denied because the gate could not evaluate the call: ${message}`);
        }
        return PASS;
    }
}
