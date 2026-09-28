// Implementations of the jh commands. Argument parsing and the help text live
// in ../cli.ts. Every command is explicit: the CLI never intercepts commits or
// final answers on its own, and `evidence observe` only records what it just
// executed and saw — the CLI has no way to attach a trial result, because exit
// code alone is not experiment evidence (see docs/security.md).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject, readProject, createFileStateService } from "../core/state/files.js";
import { compactionCandidateHash } from "../core/compaction.js";
import { loadAudit } from "../core/report.js";
import { containsKnownSecret, redactText } from "../core/redact.js";
import { dispatchClaudeHook } from "../adapters/claude-code/dispatcher.js";
import { hookEventName } from "../adapters/claude-code/types.js";
import { buildSettingsFragment, claudeHookStatus, installClaudeHooks, uninstallClaudeHooks, HOOK_TIMEOUT_SECONDS, } from "../adapters/claude-code/settings.js";
import { findProjectRoot, isInitialized, parseMode, readConfig, writeConfig } from "./config.js";
import { wireHarness } from "./harness.js";
export const EXIT = { ok: 0, failure: 1, blocked: 2, usage: 64 };
export class UsageError extends Error {
}
function flag(parsed, name) {
    const value = parsed.flags[name];
    if (typeof value !== "string" || !value)
        throw new UsageError(`--${name} needs a value`);
    return value;
}
const has = (parsed, name) => parsed.flags[name] === true || typeof parsed.flags[name] === "string";
/** 0 allowed · 2 blocked/escalated · 1 inert or unavailable (nothing was verified). */
export function exitForDecision(decision) {
    if (decision.status === "inert" || decision.status === "unavailable")
        return EXIT.failure;
    if (decision.status === "escalation" ||
        ["block", "halt", "freeze", "escalate", "confirm"].includes(decision.appliedAction))
        return EXIT.blocked;
    return EXIT.ok;
}
export function formatDecision(decision) {
    const lines = [
        `gate:      ${decision.gateId}`,
        `mode:      ${decision.mode}`,
        `status:    ${decision.status}`,
        `proposed:  ${decision.proposedAction}`,
        `applied:   ${decision.appliedAction}${decision.mode === "shadow" && decision.appliedAction !== decision.proposedAction ? " (shadow: observed, not enforced)" : ""}`,
        `reason:    ${decision.reason}`,
    ];
    if (decision.alternative)
        lines.push(`alternative: ${decision.alternative}`);
    if (decision.validationId)
        lines.push(`validation: ${decision.validationId}`);
    if (decision.recordedId)
        lines.push(`recorded:  ${decision.recordedId}`);
    if (decision.coverage)
        lines.push(`coverage:  ${decision.coverage.checked}/${decision.coverage.total}${decision.coverage.complete ? "" : " (partial — owner review required)"}`);
    return lines.join("\n");
}
function printDecision(io, parsed, decision) {
    io.stdout((has(parsed, "json") ? JSON.stringify(decision, null, 2) : formatDecision(decision)) + "\n");
}
async function projectRoot(io, parsed) {
    const start = typeof parsed.flags.root === "string" ? parsed.flags.root : io.cwd;
    return (await findProjectRoot(start)) ?? start;
}
async function wire(io, parsed, root) {
    return wireHarness({
        root, host: "cli",
        ...(typeof parsed.flags.replay === "string" ? { replay: parsed.flags.replay } : {}),
        env: io.env,
    });
}
// ---------------------------------------------------------------- init/status/mode
async function initCommand(io, parsed) {
    const goal = flag(parsed, "goal");
    const root = typeof parsed.flags.root === "string" ? parsed.flags.root : io.cwd;
    const existing = await findProjectRoot(root);
    if (existing)
        throw new UsageError(`Already initialized at ${existing} (.harness/ exists)`);
    const { directory } = await initializeProject(root, goal);
    io.stdout(`Initialized jev-harness project in ${directory}\n\n` +
        `Created: goal.md, constraints.md, attempts.jsonl, summary.json (commit these)\n` +
        `Ignored: runtime/, audit/ (session locks and verdict logs)\n\n` +
        `Next steps:\n` +
        `  jh status                 inspect project state and mode\n` +
        `  jh install claude         install Claude Code hooks (default scope: local)\n` +
        `  jh mode enforce           opt in to blocking enforcement (default: shadow)\n\n` +
        `Try it offline first:  jh example run no-new-dependencies\n`);
    return EXIT.ok;
}
async function statusCommand(io, parsed) {
    const start = typeof parsed.flags.root === "string" ? parsed.flags.root : io.cwd;
    const root = await findProjectRoot(start);
    if (!root) {
        io.stdout(`No .harness/ found at or above ${start}\nRun \`jh init --goal "<outcome>"\` to opt this project in.\n`);
        return EXIT.ok;
    }
    const config = await readConfig(root, io.env);
    const state = await readProject(root);
    if (!state)
        throw new Error("State disappeared after initialization check");
    const lines = [
        `project:     ${root}`,
        `mode:        ${config.mode} (from ${config.source})`,
        `goal:        ${state.goal}`,
        `constraints: ${state.constraints.length}`,
        ...state.constraints.map(c => `  ${c.id} (${c.createdAt}): ${c.text}`),
        `attempts:    ${state.attempts.length} (${state.attempts.filter(a => a.countsAsTrial).length} counted trials)`,
        `evidence:    ${state.evidence.length} observations`,
        `compactions: ${state.compactionIds.length} acknowledged`,
        `checkpoint:  ${state.summary ? "present" : "none"}`,
        `freeze:      ${await freezeStatus(root)}`,
    ];
    io.stdout(lines.join("\n") + "\n");
    return EXIT.ok;
}
/** Best-effort inspection of session freeze files; never mutates them. */
async function freezeStatus(root) {
    try {
        const runtime = join(root, ".harness", "runtime");
        const entries = await readdir(runtime);
        for (const name of entries) {
            if (!name.endsWith(".freeze.json"))
                continue;
            try {
                const parsed = JSON.parse(await readFile(join(runtime, name), "utf8"));
                if (parsed && typeof parsed === "object" && typeof parsed.owner === "string") {
                    return "active correction freeze in at least one session (cleared only by a new accepted user request)";
                }
            }
            catch { /* ignore an unreadable file; status is best-effort */ }
        }
        return "none";
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "none";
        return "unknown (runtime state unreadable)";
    }
}
async function modeCommand(io, parsed) {
    const root = await projectRoot(io, parsed);
    if (!(await isInitialized(root)))
        throw new UsageError("Project is not initialized; run `jh init` first");
    const value = parsed.args[1];
    if (value === undefined) {
        const config = await readConfig(root, io.env);
        io.stdout(`${config.mode} (from ${config.source})\n`);
        return EXIT.ok;
    }
    let mode;
    try {
        mode = parseMode(value);
    }
    catch (error) {
        throw new UsageError(error.message);
    }
    await writeConfig(root, { mode });
    io.stdout(`mode set to ${mode} in ${join(root, ".harness", "config.json")}\n`);
    if (mode === "enforce") {
        io.stdout(`Enforcement is now blocking for this project. Requirements:\n` +
            `  - a live Jev key (TYPESAFE_API_KEY or OPENROUTER_API_KEY) or JH_REPLAY for offline runs\n` +
            `  - installed host hooks (jh install claude) for automatic tool checks\n` +
            `When Jev, state, or audit is unavailable, enforce mode escalates instead of allowing.\n`);
    }
    else {
        io.stdout(`Shadow mode: verdicts are audited as proposals; nothing is blocked.\n`);
    }
    return EXIT.ok;
}
// ---------------------------------------------------------------- Claude hooks
function installerPaths(io) {
    return { nodePath: io.execPath, cliPath: io.cliPath };
}
function scopeOf(parsed) {
    const scope = typeof parsed.flags.scope === "string" ? parsed.flags.scope : "local";
    if (scope !== "local" && scope !== "project" && scope !== "user")
        throw new UsageError("--scope must be local, project, or user");
    return scope;
}
async function installClaudeCommand(io, parsed) {
    const scope = scopeOf(parsed);
    const root = await projectRoot(io, parsed);
    const paths = installerPaths(io);
    if (has(parsed, "print")) {
        io.stdout(JSON.stringify(buildSettingsFragment(paths), null, 2) + "\n");
        return EXIT.ok;
    }
    const report = await installClaudeHooks({ scope, projectRoot: root, homeDir: io.env.HOME ?? "", paths });
    io.stdout(`${report.action}: ${report.file}\n`);
    if (report.backup)
        io.stdout(`backup: ${report.backup}\n`);
    for (const warning of report.warnings)
        io.stderr(`warning: ${warning}\n`);
    io.stdout(`Verify with: jh hooks claude --scope ${scope}\n`);
    return EXIT.ok;
}
async function uninstallClaudeCommand(io, parsed) {
    const scope = scopeOf(parsed);
    const root = await projectRoot(io, parsed);
    const report = await uninstallClaudeHooks({ scope, projectRoot: root, homeDir: io.env.HOME ?? "" });
    io.stdout(`${report.action}: ${report.file}\n`);
    if (report.backup)
        io.stdout(`backup: ${report.backup}\n`);
    for (const warning of report.warnings)
        io.stderr(`warning: ${warning}\n`);
    return EXIT.ok;
}
async function hooksClaudeCommand(io, parsed) {
    const root = await projectRoot(io, parsed);
    const scopes = typeof parsed.flags.scope === "string" ? [scopeOf(parsed)] : ["local", "project", "user"];
    let anyInstalled = false;
    for (const scope of scopes) {
        const report = await claudeHookStatus({ scope, projectRoot: root, homeDir: io.env.HOME ?? "" });
        io.stdout(`${scope}: ${report.file}${report.exists ? "" : " (absent)"}\n`);
        for (const event of report.events) {
            if (event.installed)
                anyInstalled = true;
            io.stdout(`  ${event.installed ? "installed" : "   —     "} ${event.event}\n`);
        }
    }
    if (!anyInstalled)
        io.stdout(`No jev-harness hooks installed. Run: jh install claude\n`);
    return EXIT.ok;
}
/**
 * `jh hook claude`: the command installed into Claude settings. stdin →
 * dispatcher → stdout/exit. Two hard guarantees beyond the dispatcher itself:
 * - Errors before the dispatcher (unreadable/malformed .harness/config.json,
 *   replay file, state) never degrade to a bare exit 1 on PreToolUse — per the
 *   official hook contract exit 1 is a non-blocking error and the tool call
 *   would proceed. An unevaluable PreToolUse is denied with exit 2 instead.
 * - The whole dispatch observes a deadline below the installed hook timeout
 *   (HOOK_TIMEOUT_SECONDS), then the process exits immediately so a hung
 *   provider connection cannot stall the host past the deadline.
 * Untrusted stdin is never echoed back: error messages carry no input content.
 */
/** Milliseconds; must stay below HOOK_TIMEOUT_SECONDS at the call site. */
const HOOK_BUDGET_MS = (HOOK_TIMEOUT_SECONDS - 3) * 1_000;
/** Write the response synchronously and exit now; pending I/O must not outlive the hook deadline. */
function emitHookAndExit(response) {
    try {
        if (response.stdout)
            writeSync(1, response.stdout);
    }
    catch { /* closed pipe */ }
    try {
        if (response.stderr)
            writeSync(2, response.stderr);
    }
    catch { /* closed pipe */ }
    process.exit(response.exitCode);
}
/** Sanitized one-line error text with no stdin content. */
function hookErrorText(error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return message.replace(/[\n\r\0]+/g, " ").slice(0, 200);
}
function hookSetupFailure(eventName, error) {
    const reason = hookErrorText(error);
    if (eventName === "PreToolUse") {
        emitHookAndExit({
            exitCode: EXIT.blocked,
            stdout: JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "PreToolUse", permissionDecision: "deny",
                    permissionDecisionReason: `jev-harness could not initialize (${reason}); denied because the gate could not evaluate the call. Fix .harness/config.json or uninstall the hooks.`,
                },
            }) + "\n",
            stderr: "",
        });
    }
    // Other events cannot block meaningfully (and exit 2 on UserPromptSubmit
    // would erase the user's prompt), so this stays a non-blocking error.
    emitHookAndExit({ exitCode: EXIT.failure, stdout: "", stderr: `jh hook: ${reason}\n` });
}
async function hookClaudeCommand(io) {
    const raw = await io.readStdin();
    let parsedInput;
    try {
        parsedInput = JSON.parse(raw);
    }
    catch {
        parsedInput = raw;
    }
    const record = parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)
        ? parsedInput : {};
    const eventName = hookEventName(parsedInput);
    let response;
    try {
        const start = typeof io.env.CLAUDE_PROJECT_DIR === "string" && io.env.CLAUDE_PROJECT_DIR
            ? io.env.CLAUDE_PROJECT_DIR
            : typeof record.cwd === "string" && record.cwd ? record.cwd : io.cwd;
        const root = (await findProjectRoot(start)) ?? start;
        const wiring = await wireHarness({
            root, host: "claude-code",
            sessionId: typeof record.session_id === "string" && record.session_id ? record.session_id : "unknown",
            requestId: "hook-dispatch",
            env: io.env,
        });
        let timer;
        try {
            response = await Promise.race([
                dispatchClaudeHook(parsedInput, { harness: wiring.harness, mode: wiring.mode, env: io.env }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("hook deadline exceeded")), HOOK_BUDGET_MS);
                    timer.unref();
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch (error) {
        hookSetupFailure(eventName, error);
    }
    emitHookAndExit(response);
}
// ---------------------------------------------------------------- explicit checks
async function checkShellCommand(io, parsed) {
    const parts = [...parsed.args.slice(2), ...parsed.rest];
    const command = parts.join(" ").trim();
    if (!command)
        throw new UsageError("jh check shell needs a command, e.g. jh check shell -- npm install left-pad");
    const wiring = await wire(io, parsed, await projectRoot(io, parsed));
    const decision = await wiring.harness.onToolPreflight({
        context: wiring.context, callId: `cli-${randomUUID()}`, toolName: "shell", intent: "shell", input: { command },
    });
    printDecision(io, parsed, decision);
    return exitForDecision(decision);
}
async function checkWriteCommand(io, parsed) {
    const path = flag(parsed, "path");
    const input = { path };
    if (typeof parsed.flags["content-file"] === "string") {
        input.content = await readFile(parsed.flags["content-file"], "utf8");
    }
    const wiring = await wire(io, parsed, await projectRoot(io, parsed));
    const decision = await wiring.harness.onToolPreflight({
        context: wiring.context, callId: `cli-${randomUUID()}`, toolName: "write", intent: "write", input,
    });
    printDecision(io, parsed, decision);
    return exitForDecision(decision);
}
async function checkClaimCommand(io, parsed) {
    const claim = flag(parsed, "claim");
    const evidence = flag(parsed, "evidence").split(",").map(id => id.trim()).filter(Boolean);
    const purpose = typeof parsed.flags.purpose === "string" ? parsed.flags.purpose : "explicit";
    if (purpose !== "checkpoint" && purpose !== "commit" && purpose !== "explicit") {
        throw new UsageError("--purpose must be checkpoint, commit, or explicit");
    }
    const wiring = await wire(io, parsed, await projectRoot(io, parsed));
    const decision = await wiring.harness.checkClaim({ context: wiring.context, claim, evidenceIds: evidence, purpose });
    printDecision(io, parsed, decision);
    return exitForDecision(decision);
}
// ---------------------------------------------------------------- constraints & attempts
async function constraintsCommand(io, parsed) {
    const root = await projectRoot(io, parsed);
    const action = parsed.args[1] ?? "list";
    if (action === "list") {
        const state = await readProject(root);
        if (!state)
            throw new UsageError("Project is not initialized; run `jh init` first");
        if (has(parsed, "json"))
            io.stdout(JSON.stringify(state.constraints, null, 2) + "\n");
        else
            io.stdout(state.constraints.length
                ? state.constraints.map(c => `${c.id} (${c.createdAt}): ${c.text}`).join("\n") + "\n"
                : "No standing constraints. Add one with: jh constraints add \"<rule>\"\n");
        return EXIT.ok;
    }
    if (action === "add") {
        const text = parsed.args.slice(2).join(" ").trim();
        if (!text)
            throw new UsageError(`jh constraints add "<rule>"`);
        if (/[\r\n]/.test(text))
            throw new UsageError("A standing constraint must fit on one line");
        if (containsKnownSecret(text))
            throw new UsageError("Constraint looks like it contains a credential; rephrase it safely");
        const wiring = await wire(io, parsed, root);
        const state = createFileStateService();
        const rule = { id: `c-${randomUUID().slice(0, 12)}`, createdAt: new Date().toISOString().slice(0, 10), text };
        // Owner-explicit write with compare-and-swap retry; no gate involvement.
        for (let attempt = 0;; attempt++) {
            const current = await state.read(wiring.context);
            if (!current)
                throw new UsageError("Project is not initialized; run `jh init` first");
            if (current.constraints.some(c => c.text === text)) {
                io.stdout(`Already recorded: ${current.constraints.find(c => c.text === text).id}\n`);
                return EXIT.ok;
            }
            try {
                await state.write(wiring.context, current.revision, { kind: "constraint", constraint: rule });
                io.stdout(`Recorded standing rule ${rule.id}: ${text}\nIt applies to plans, commands, and file changes in this project.\n`);
                return EXIT.ok;
            }
            catch (error) {
                if (attempt >= 2 || !(error instanceof Error) || !/revision conflict/.test(error.message))
                    throw error;
            }
        }
    }
    throw new UsageError(`Unknown constraints action "${action}". Use: list, add. To remove a rule, edit .harness/constraints.md directly — removal is an owner edit, not an agent operation.`);
}
async function attemptsCommand(io, parsed) {
    const root = await projectRoot(io, parsed);
    const action = parsed.args[1] ?? "list";
    if (action === "list") {
        const state = await readProject(root);
        if (!state)
            throw new UsageError("Project is not initialized; run `jh init` first");
        if (has(parsed, "json"))
            io.stdout(JSON.stringify(state.attempts, null, 2) + "\n");
        else
            io.stdout(state.attempts.length
                ? state.attempts.map(a => `${a.id}: ${a.result}${a.countsAsTrial ? " (trial)" : ""}\n  hypothesis: ${a.hypothesis}\n  method: ${a.method}\n  evidence: ${a.evidenceIds.join(", ") || "none"}`).join("\n") + "\n"
                : "No attempts registered. Use: jh attempts register --hypothesis <h> --method <m>\n");
        return EXIT.ok;
    }
    if (action === "register") {
        const hypothesis = flag(parsed, "hypothesis");
        const method = flag(parsed, "method");
        const wiring = await wire(io, parsed, root);
        const decision = await wiring.harness.registerAttempt({
            context: wiring.context, hypothesis, method,
            ...(typeof parsed.flags["changed-variable"] === "string" ? { changedVariable: parsed.flags["changed-variable"] } : {}),
        });
        printDecision(io, parsed, decision);
        if (wiring.mode === "shadow" && decision.status === "ready") {
            io.stdout(`note: shadow mode — verdict observed, attempt not recorded. Switch with: jh mode enforce\n`);
        }
        return exitForDecision(decision);
    }
    throw new UsageError(`Unknown attempts action "${action}". Use: list, register`);
}
/**
 * Minimal environment for observed executions: enough to resolve and run
 * programs, none of the caller's API keys, tokens, or session variables.
 * Observed commands run as the owner but never inherit secrets.
 */
function sanitizedEnv() {
    const env = {};
    for (const name of ["PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
        "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "USER"]) {
        const value = process.env[name];
        if (typeof value === "string" && value)
            env[name] = value;
    }
    return env;
}
/**
 * Bounded foreground execution with a sanitized environment and capped output
 * capture. Never uses a shell. On timeout the whole process tree is killed
 * (the child leads its own process group on POSIX; group kill falls back to
 * the direct child where group signaling is unavailable).
 */
async function execute(command, cwd, timeoutMs) {
    const CAP = 4_000;
    return new Promise(resolve => {
        const child = spawn(command[0], command.slice(1), {
            cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: true, env: sanitizedEnv(),
        });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const killTree = (signal) => {
            try {
                process.kill(-child.pid, signal);
            }
            catch {
                try {
                    child.kill(signal);
                }
                catch { /* already gone */ }
            }
        };
        const finish = (code, spawnError) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const mark = (text) => truncated && text ? `${text}…[truncated]` : text;
            resolve({ code, timedOut, stdout: mark(stdout.slice(0, CAP)), stderr: mark(stderr.slice(0, CAP)), ...(spawnError ? { spawnError } : {}) });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killTree("SIGTERM");
            setTimeout(() => { if (!settled)
                killTree("SIGKILL"); }, 2_000).unref();
        }, timeoutMs);
        child.stdout.on("data", chunk => { if (stdout.length < CAP)
            stdout += String(chunk);
        else
            truncated = true; });
        child.stderr.on("data", chunk => { if (stderr.length < CAP)
            stderr += String(chunk);
        else
            truncated = true; });
        child.on("error", error => finish(null, error.message));
        child.on("close", code => finish(code));
    });
}
/**
 * Execute a command and record exactly what was observed. The CLI deliberately
 * cannot attach a trial result (confirmed/refuted): an exit code alone is not
 * experiment evidence, and a caller-supplied classification would be a forged
 * outcome. Grading requires a trusted embedding of the core API whose owner
 * configured the exact executable, method, and expectation up front — see
 * docs/security.md. `--result` and `--expect-exit` were removed; passing them
 * is a usage error.
 */
async function evidenceObserveCommand(io, parsed) {
    const method = flag(parsed, "method");
    if (!parsed.rest.length)
        throw new UsageError("jh evidence observe --method <m> -- <command...>  (the command is executed and its output observed)");
    if (parsed.flags.result !== undefined || parsed.flags["expect-exit"] !== undefined) {
        throw new UsageError("jh evidence observe does not accept --result/--expect-exit: the CLI records observations only and cannot grade experiments. " +
            "Trial results come from a trusted embedding of the core recordEvidence API with an owner-configured expectation (see docs/security.md).");
    }
    const attemptId = typeof parsed.flags.attempt === "string" ? parsed.flags.attempt : undefined;
    const timeoutSeconds = typeof parsed.flags.timeout === "string" ? Number(parsed.flags.timeout) : 60;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300)
        throw new UsageError("--timeout must be 1–300 seconds");
    const root = await projectRoot(io, parsed);
    // Never execute anything for an uninitialized (inert) project: observation
    // without a place to record it proves nothing, and execution is not free.
    if (!(await isInitialized(root))) {
        io.stdout("Project is not initialized; nothing was executed. Run `jh init` first.\n");
        return EXIT.failure;
    }
    const wiring = await wire(io, parsed, root);
    // Explicit user-requested execution (documented): runs in shadow mode too,
    // where the verdict is advisory and nothing is persisted.
    const run = await execute(parsed.rest, root, timeoutSeconds * 1_000);
    const summary = run.spawnError
        ? `command failed to start: ${run.spawnError}`
        : `exit ${run.code ?? "unknown"}${run.timedOut ? ` (killed after ${timeoutSeconds}s)` : ""}; stdout: ${run.stdout.trim() || "(empty)"}; stderr: ${run.stderr.trim() || "(empty)"}`;
    const evidence = {
        id: `e-${randomUUID().slice(0, 12)}`,
        source: "harness",
        observedAt: new Date().toISOString(),
        method,
        observation: redactText(summary).slice(0, 7_000),
    };
    const decision = await wiring.harness.recordEvidence({
        context: wiring.context, evidence,
        ...(attemptId ? { attemptId } : {}),
    });
    io.stdout(`observed: ${summary.slice(0, 500)}\n`);
    printDecision(io, parsed, decision);
    if (wiring.mode === "shadow" && decision.status === "ready") {
        io.stdout(`note: shadow mode — verdict observed, evidence not recorded. Switch with: jh mode enforce\n`);
    }
    return exitForDecision(decision);
}
// ---------------------------------------------------------------- compaction
async function compactCommand(io, parsed) {
    const action = parsed.args[1];
    const root = await projectRoot(io, parsed);
    const wiring = await wire(io, parsed, root);
    if (action === "validate") {
        const summaryText = typeof parsed.flags["summary-file"] === "string"
            ? await readFile(parsed.flags["summary-file"], "utf8")
            : typeof parsed.flags.summary === "string" ? parsed.flags.summary : "";
        const noteToSelf = typeof parsed.flags["note-file"] === "string" ? await readFile(parsed.flags["note-file"], "utf8") : undefined;
        let checkpoint;
        if (typeof parsed.flags["checkpoint-file"] === "string") {
            checkpoint = JSON.parse(await readFile(parsed.flags["checkpoint-file"], "utf8"));
        }
        const reason = typeof parsed.flags.reason === "string" ? parsed.flags.reason : "manual";
        if (!["manual", "threshold", "overflow", "external"].includes(reason)) {
            throw new UsageError("--reason must be manual, threshold, overflow, or external");
        }
        const { decision, retainedPolicyBlock } = await wiring.harness.validateCompaction({
            context: wiring.context, summaryText, ...(noteToSelf !== undefined ? { noteToSelf } : {}),
            ...(checkpoint ? { checkpoint } : {}), reason: reason,
        });
        if (has(parsed, "json")) {
            io.stdout(JSON.stringify({ decision, retainedPolicyBlock }, null, 2) + "\n");
        }
        else {
            printDecision(io, parsed, decision);
            if (retainedPolicyBlock)
                io.stdout(`--- retained policy block (inject separately; never part of the note) ---\n${retainedPolicyBlock}\n`);
        }
        return exitForDecision(decision);
    }
    if (action === "acknowledge") {
        const compactionId = flag(parsed, "compaction-id");
        const validationId = flag(parsed, "validation-id");
        // Resend the exact validated candidate when available: the core rejects an
        // ack whose candidate hash does not match the validation record.
        const summaryText = typeof parsed.flags["summary-file"] === "string"
            ? await readFile(parsed.flags["summary-file"], "utf8")
            : typeof parsed.flags.summary === "string" ? parsed.flags.summary : undefined;
        const noteToSelf = typeof parsed.flags["note-file"] === "string" ? await readFile(parsed.flags["note-file"], "utf8") : undefined;
        let checkpoint;
        if (typeof parsed.flags["checkpoint-file"] === "string") {
            checkpoint = JSON.parse(await readFile(parsed.flags["checkpoint-file"], "utf8"));
        }
        const candidate = summaryText !== undefined
            ? compactionCandidateHash({ summaryText, ...(noteToSelf !== undefined ? { noteToSelf } : {}), ...(checkpoint ? { checkpoint } : {}) })
            : undefined;
        const decision = await wiring.harness.acknowledgeCompaction({
            context: wiring.context, compactionId, validationId, succeeded: true,
            ...(candidate ? { candidateHash: candidate } : {}), ...(checkpoint ? { checkpoint } : {}),
        });
        printDecision(io, parsed, decision);
        return exitForDecision(decision);
    }
    throw new UsageError(`Unknown compact action "${String(action)}". Use: validate, acknowledge`);
}
// ---------------------------------------------------------------- replay & eval
async function replayCommand(io, parsed) {
    const file = parsed.args[1];
    if (!file)
        throw new UsageError("jh replay <audit.jsonl>");
    const entries = await loadAudit(file);
    let violations = 0;
    const lines = [];
    for (const entry of entries) {
        const d = entry.decision;
        const problems = [];
        if (d.mode === "shadow" && d.appliedAction !== "allow" && d.appliedAction !== "none") {
            problems.push("shadow entry applied a gate action");
        }
        if (d.mode === "enforce" && d.appliedAction !== d.proposedAction) {
            problems.push("enforce entry did not apply its proposed action");
        }
        if (d.status === "unavailable" && d.mode === "enforce" && d.appliedAction !== "escalate") {
            problems.push("unavailable verdict did not escalate in enforce mode");
        }
        violations += problems.length;
        lines.push(`${entry.at}  ${d.gateId}  ${d.mode}  ${d.status}  proposed=${d.proposedAction} applied=${d.appliedAction}` +
            `${problems.length ? `  INVARIANT: ${problems.join("; ")}` : ""}\n    ${d.reason.slice(0, 160)}`);
    }
    if (has(parsed, "json")) {
        io.stdout(JSON.stringify({ entries: entries.length, violations }, null, 2) + "\n");
    }
    else {
        io.stdout(lines.join("\n") + "\n");
        io.stdout(`${entries.length} entries, ${violations} invariant violations\n` +
            `note: audit entries omit raw inputs by design, so verdicts can be inspected but not re-evaluated offline.\n`);
    }
    return violations ? EXIT.failure : EXIT.ok;
}
async function evalCommand(io, parsed) {
    const dir = typeof parsed.flags.fixtures === "string" ? parsed.flags.fixtures
        : fileURLToPath(new URL("../../eval/", import.meta.url));
    const names = (await readdir(dir)).filter(name => name.endsWith(".jsonl")).sort();
    if (!names.length)
        throw new UsageError(`No .jsonl fixtures in ${dir}`);
    let cases = 0;
    const lines = [];
    for (const name of names) {
        const raw = await readFile(join(dir, name), "utf8");
        if (/(?:Bearer\s+|ghp_)[A-Za-z0-9]{20,}/.test(raw))
            throw new Error(`${name} appears to contain a credential`);
        const rows = raw.trim().split("\n").map(line => JSON.parse(line));
        const ids = new Set(rows.map(row => row.id));
        if (ids.size !== rows.length)
            throw new Error(`${name} has duplicate case ids`);
        if (!rows.every(row => row && typeof row.expected === "object"))
            throw new Error(`${name} cases need an expected object`);
        cases += rows.length;
        lines.push(`${name}: ${rows.length} cases`);
    }
    io.stdout(lines.join("\n") + "\n" +
        `${cases} synthetic cases are well-formed.\n` +
        `These fixtures are labels for offline contract tests; they do not measure live Jev judgment.\n` +
        `No measured live accuracy exists yet — treat enforcement as uncalibrated until a live evaluation is run and published.\n`);
    return EXIT.ok;
}
// ---------------------------------------------------------------- examples
function examplesDir() {
    return fileURLToPath(new URL("../../examples/", import.meta.url));
}
async function exampleCommand(io, parsed) {
    const action = parsed.args[1] ?? "list";
    let names;
    try {
        const infos = await readdir(examplesDir());
        names = [];
        for (const name of infos) {
            if ((await lstat(join(examplesDir(), name))).isDirectory())
                names.push(name);
        }
        names.sort();
    }
    catch {
        names = [];
    }
    if (action === "list") {
        if (!names.length)
            throw new UsageError("No bundled examples found (examples/ is missing from this install)");
        for (const name of names) {
            let summary = "";
            try {
                const meta = JSON.parse(await readFile(join(examplesDir(), name, "example.json"), "utf8"));
                if (meta && typeof meta === "object" && typeof meta.summary === "string") {
                    summary = ` — ${meta.summary}`;
                }
            }
            catch { /* summary is optional */ }
            io.stdout(`${name}${summary}\n`);
        }
        io.stdout(`Run one with: jh example run <name>   (offline; synthetic replay answers, no API key needed)\n`);
        return EXIT.ok;
    }
    if (action === "run") {
        const name = parsed.args[2] ?? "";
        if (!/^[a-z0-9-]+$/.test(name) || !names.includes(name)) {
            throw new UsageError(`Unknown example "${name}". Available: ${names.join(", ")}`);
        }
        const child = spawn(io.execPath, [join(examplesDir(), name, "run.mjs"), ...(has(parsed, "check") ? ["--check"] : [])], {
            stdio: "inherit", timeout: 30_000,
        });
        return new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code, signal) => {
                if (signal) {
                    io.stderr(`example ${name} was killed (${signal})\n`);
                    resolve(EXIT.failure);
                }
                else
                    resolve(code ?? EXIT.failure);
            });
        });
    }
    throw new UsageError(`Unknown example action "${action}". Use: list, run`);
}
// ---------------------------------------------------------------- dispatch
export async function runCommand(parsed, io) {
    const [command] = parsed.args;
    switch (command) {
        case "init": return initCommand(io, parsed);
        case "status": return statusCommand(io, parsed);
        case "mode": return modeCommand(io, parsed);
        case "install":
            if (parsed.args[1] === "claude")
                return installClaudeCommand(io, parsed);
            throw new UsageError(`jh install claude is the only installer (got "${parsed.args[1] ?? ""}")`);
        case "uninstall":
            if (parsed.args[1] === "claude")
                return uninstallClaudeCommand(io, parsed);
            throw new UsageError(`jh uninstall claude is the only uninstaller (got "${parsed.args[1] ?? ""}")`);
        case "hooks":
            if (parsed.args[1] === "claude")
                return hooksClaudeCommand(io, parsed);
            throw new UsageError(`jh hooks claude is the only hook status (got "${parsed.args[1] ?? ""}")`);
        case "hook":
            if (parsed.args[1] === "claude")
                return hookClaudeCommand(io);
            throw new UsageError(`jh hook claude is the only hook dispatcher (got "${parsed.args[1] ?? ""}")`);
        case "check":
            if (parsed.args[1] === "shell")
                return checkShellCommand(io, parsed);
            if (parsed.args[1] === "write")
                return checkWriteCommand(io, parsed);
            if (parsed.args[1] === "claim")
                return checkClaimCommand(io, parsed);
            throw new UsageError(`jh check needs one of: shell, write, claim`);
        case "constraints": return constraintsCommand(io, parsed);
        case "attempts": return attemptsCommand(io, parsed);
        case "evidence":
            if (parsed.args[1] === "observe")
                return evidenceObserveCommand(io, parsed);
            throw new UsageError(`jh evidence observe --method <m> -- <command...>`);
        case "compact": return compactCommand(io, parsed);
        case "replay": return replayCommand(io, parsed);
        case "eval": return evalCommand(io, parsed);
        case "example": return exampleCommand(io, parsed);
        default:
            throw new UsageError(command ? `Unknown command "${command}"` : "No command given");
    }
}
