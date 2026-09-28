import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { redactText, redactValue } from "./redact.js";
import { finalBlock } from "./messages.js";
export function digest(value) { return createHash("sha256").update(value).digest("hex"); }
/** Session-scoped JSONL report; do not include commands, prompts, tool outputs, or credentials. */
export function createFileAuditService(context) {
    return {
        async append(entry) {
            if (!context.trusted || entry.host !== context.host || entry.sessionHash !== digest(context.sessionId)) {
                throw new Error("Audit context mismatch or untrusted project");
            }
            const root = await realpath(context.projectRoot);
            const dir = join(root, ".harness");
            const rootInfo = await lstat(dir);
            if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
                throw new Error("Project is not initialized");
            const audit = join(dir, "audit");
            try {
                await mkdir(audit, { mode: 0o700 });
            }
            catch (e) {
                if (e.code !== "EEXIST")
                    throw e;
                const info = await lstat(audit);
                if (!info.isDirectory() || info.isSymbolicLink())
                    throw new Error("Unsafe audit directory");
            }
            const path = join(audit, `${entry.sessionHash}.jsonl`);
            try {
                const info = await lstat(path);
                if (!info.isFile() || info.isSymbolicLink())
                    throw new Error("Unsafe audit file");
            }
            catch (e) {
                if (e.code !== "ENOENT")
                    throw e;
            }
            const safe = redactValue(entry, 24_000);
            // O_APPEND makes individual lines append-only under concurrent hook processes.
            const fd = await open(path, "a", 0o600);
            try {
                await fd.writeFile(JSON.stringify(safe) + "\n");
                await fd.sync();
            }
            finally {
                await fd.close();
            }
        },
    };
}
export async function loadAudit(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000)
        throw new Error("Invalid audit file");
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map(line => {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== "object" || !("decision" in entry))
            throw new Error("Malformed audit entry");
        return entry;
    });
}
/** Replay a recorded answer against the same fixture state, without contacting Jev. */
export function replayVerdict(gate, input, state, answers, recorded) {
    const verdict = gate.evaluate(input, answers, state);
    const reason = ["block", "halt", "freeze"].includes(verdict.action)
        ? finalBlock(verdict.reason, verdict.alternative ?? "Ask the owner for an approved approach or use a reversible project-local alternative.")
        : redactText(verdict.reason);
    if (recorded.gateId !== gate.id || verdict.action !== recorded.proposedAction || reason !== recorded.reason)
        return false;
    if (recorded.mode === "shadow" && recorded.appliedAction !== "allow" && recorded.appliedAction !== "none")
        return false;
    if (recorded.mode === "enforce" && recorded.status === "ready" && recorded.appliedAction !== verdict.action)
        return false;
    return true;
}
