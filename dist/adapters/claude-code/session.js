// Per-session correlation between one accepted user prompt and its tool events.
// Claude Code does not provide a request id on tool hooks, so the dispatcher
// remembers the current request per session in ignored .harness/runtime/ state.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
const FILE_LIMIT = 4096;
const digest = (value) => createHash("sha256").update(value).digest("hex");
/**
 * Best-effort stable identity of the current transcript boundary: the `uuid`
 * of the last transcript entry, read synchronously from the tail of the file.
 * The official hook documentation notes the transcript is written
 * asynchronously and may lag the current turn, and does not specify whether a
 * failed hook execution is ever retried — so this is a dedup hint, not a
 * guarantee. Returns undefined when no usable boundary exists.
 */
export function transcriptBoundary(transcriptPath) {
    if (!transcriptPath || transcriptPath.includes("\0"))
        return undefined;
    let fd;
    try {
        fd = openSync(transcriptPath, "r");
    }
    catch {
        return undefined;
    }
    try {
        const size = fstatSync(fd).size;
        if (size <= 0 || size > 512 * 1024 * 1024)
            return undefined;
        const tail = Buffer.alloc(Math.min(size, 65_536));
        const read = readSync(fd, tail, 0, tail.length, size - tail.length);
        if (read <= 0)
            return undefined;
        const lines = tail.subarray(0, read).toString("utf8").split("\n").filter(line => line.trim());
        const last = lines.at(-1);
        if (!last)
            return undefined;
        const parsed = JSON.parse(last);
        if (parsed && typeof parsed === "object" && typeof parsed.uuid === "string") {
            return parsed.uuid;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Derive the request id for one accepted prompt delivery. Two separately
 * accepted prompts with identical text are distinct requests and must not
 * reuse an old id (a repeated prompt after a correction is a new request, not
 * a retry), so each delivery mixes in a per-delivery discriminator:
 * an explicit `delivery` value (tests), else the current transcript boundary,
 * else fresh entropy. A redelivered hook payload observed at the same
 * transcript boundary dedupes to the same id and is treated as a retry, so a
 * duplicate delivery cannot release a later request's freeze; core
 * idempotency dedupes any repeated acceptance of the same id. Without a
 * transcript boundary there is no way to distinguish a redelivery from a
 * genuinely re-sent prompt — that limit is documented in docs/claude-code.md.
 */
export function requestIdForPrompt(sessionId, transcriptPath, prompt, delivery) {
    const discriminator = delivery ?? transcriptBoundary(transcriptPath) ?? randomUUID();
    return `req-${digest(`${sessionId}\n${transcriptPath ?? ""}\n${prompt}\n${discriminator}`).slice(0, 24)}`;
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
