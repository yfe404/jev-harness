// Per-session correlation between one accepted user prompt and its tool events.
// Claude Code does not provide a request id on tool hooks, so the dispatcher
// remembers the current request per session in ignored .harness/runtime/ state.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
const FILE_LIMIT = 4096;
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** Derive a retry-stable request id: re-sent identical prompts map to the same request. */
export function requestIdForPrompt(sessionId, transcriptPath, prompt) {
    return `req-${digest(`${sessionId}\n${transcriptPath ?? ""}\n${prompt}`).slice(0, 24)}`;
}
/** Deterministic fallback when no accepted prompt was recorded for the session. */
export function fallbackRequestId(sessionId) {
    return `req-${digest(`${sessionId}\nfallback`).slice(0, 24)}`;
}
export function createFileSessionStore(options) {
    const now = options?.now ?? (() => new Date());
    async function runtimeDir(projectRoot) {
        try {
            const harness = join(await realpath(projectRoot), ".harness");
            const info = await lstat(harness);
            if (!info.isDirectory() || info.isSymbolicLink())
                return null;
            const runtime = join(harness, "runtime");
            try {
                await mkdir(runtime, { mode: 0o700 });
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
            const runtimeInfo = await lstat(runtime);
            if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink())
                return null;
            return runtime;
        }
        catch {
            return null;
        }
    }
    const pathFor = (dir, sessionId) => join(dir, `claude-session-${digest(sessionId).slice(0, 32)}.json`);
    return {
        async currentRequest(projectRoot, sessionId) {
            const dir = await runtimeDir(projectRoot);
            if (!dir)
                return null;
            try {
                const path = pathFor(dir, sessionId);
                const info = await lstat(path);
                if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT)
                    return null;
                const parsed = JSON.parse(await readFile(path, "utf8"));
                if (!parsed || typeof parsed !== "object")
                    return null;
                const id = parsed.currentRequestId;
                return typeof id === "string" && /^req-[0-9a-f]{24}$/.test(id) ? id : null;
            }
            catch {
                return null;
            }
        },
        async setCurrentRequest(projectRoot, sessionId, requestId) {
            const dir = await runtimeDir(projectRoot);
            if (!dir)
                return;
            const path = pathFor(dir, sessionId);
            const temp = `${path}.${randomUUID()}.tmp`;
            const fd = await open(temp, "wx", 0o600);
            try {
                await fd.writeFile(JSON.stringify({ currentRequestId: requestId, updatedAt: now().toISOString() }));
                await fd.sync();
            }
            finally {
                await fd.close();
            }
            try {
                await rename(temp, path);
            }
            catch (error) {
                await unlink(temp).catch(() => { });
                throw error;
            }
        },
    };
}
/** In-memory store for tests and embedded dispatchers. */
export function createMemorySessionStore() {
    const requests = new Map();
    const key = (root, session) => `${root}\n${session}`;
    return {
        async currentRequest(projectRoot, sessionId) { return requests.get(key(projectRoot, sessionId)) ?? null; },
        async setCurrentRequest(projectRoot, sessionId, requestId) { requests.set(key(projectRoot, sessionId), requestId); },
    };
}
