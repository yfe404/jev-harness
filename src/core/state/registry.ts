import { open, readFile, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CompactionRegistry, CompactionValidationRecord, EventContext } from "../contracts.js";
import { digest } from "../report.js";
import { plainRecord } from "./schema.js";

const MAX_REGISTRY = 1_000_000;
const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function validateRecord(value: unknown): CompactionValidationRecord {
  if (!plainRecord(value)) throw new Error("Malformed compaction validation record");
  const r = value as unknown as CompactionValidationRecord;
  if (!isId(r.validationId) || !isHash(r.projectHash) || !isHash(r.sessionHash) || !isHash(r.requestHash) || !isHash(r.candidateHash))
    throw new Error("Malformed compaction validation record");
  if (r.checkpointHash !== undefined && !isHash(r.checkpointHash)) throw new Error("Malformed compaction validation record");
  if (r.host !== "claude-code" && r.host !== "pi" && r.host !== "cli") throw new Error("Malformed compaction validation host");
  if (r.mode !== "shadow" && r.mode !== "enforce") throw new Error("Malformed compaction validation mode");
  if (typeof r.stateRevision !== "string" || r.stateRevision.length < 1 || r.stateRevision.length > 200)
    throw new Error("Malformed compaction validation revision");
  if (typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt))) throw new Error("Malformed compaction validation time");
  return r;
}

type Folded = Readonly<{ record: CompactionValidationRecord; compactionId?: string }>;
function fold(lines: string[]): Map<string, { record: CompactionValidationRecord; compactionId?: string }> {
  const entries = new Map<string, { record: CompactionValidationRecord; compactionId?: string }>();
  for (const line of lines) {
    if (!line) continue;
    let item: unknown;
    try { item = JSON.parse(line); } catch { throw new Error("Corrupt compaction registry"); }
    if (!plainRecord(item)) throw new Error("Corrupt compaction registry");
    if (item.kind === "validation") {
      const record = validateRecord(item.record);
      if (entries.has(record.validationId)) throw new Error("Duplicate compaction validation id");
      entries.set(record.validationId, { record });
    } else if (item.kind === "ack") {
      if (!isId(item.validationId) || !isId(item.compactionId)) throw new Error("Corrupt compaction acknowledgment");
      const found = entries.get(item.validationId);
      if (!found) throw new Error("Compaction acknowledgment without a validation");
      if (found.compactionId !== undefined && found.compactionId !== item.compactionId)
        throw new Error("Conflicting compaction acknowledgments");
      found.compactionId = item.compactionId;
    } else throw new Error("Unknown compaction registry record");
  }
  return entries;
}
function reverseBinding(entries: Map<string, { record: CompactionValidationRecord; compactionId?: string }>, compactionId: string): string | null {
  for (const [validationId, entry] of entries) if (entry.compactionId === compactionId) return validationId;
  return null;
}

async function registryPath(projectRoot: string): Promise<string> {
  const root = await realpath(projectRoot);
  const dir = join(root, ".harness");
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Project is not initialized");
  const runtime = join(dir, "runtime");
  try { await mkdir(runtime, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(runtime);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe runtime directory");
  return join(runtime, "compactions.jsonl");
}
async function readEntries(path: string): Promise<Map<string, { record: CompactionValidationRecord; compactionId?: string }>> {
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REGISTRY) throw new Error("Unsafe compaction registry");
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  return fold(text.split("\n"));
}
async function appendLine(path: string, line: string): Promise<void> {
  if (Buffer.byteLength(line) > 4_000) throw new Error("Compaction registry record too large");
  const fd = await open(path, "a", 0o600);
  try { await fd.writeFile(line + "\n"); await fd.sync(); } finally { await fd.close(); }
}
async function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const guard = `${path}.lock`;
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  for (let n = 0; n < 50; n++) {
    try { fd = await open(guard, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (n === 49) throw new Error("Compaction registry is locked by another process");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!fd) throw new Error("Could not lock compaction registry");
  try { return await task(); }
  finally {
    await fd.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(guard);
  }
}

/** Durable append-only registry in the project's ignored `.harness/runtime/`.
 * Bound to the construction context's host and project; corrupt or oversized
 * files fail closed instead of being guessed around. */
export function createFileCompactionRegistry(context: EventContext): CompactionRegistry {
  return {
    async save(record: CompactionValidationRecord) {
      const checked = validateRecord(record);
      if (checked.host !== context.host || checked.projectHash !== digest(context.projectRoot))
        throw new Error("Compaction validation does not belong to this project or host");
      const path = await registryPath(context.projectRoot);
      await withLock(path, async () => {
        if ((await readEntries(path)).has(checked.validationId)) throw new Error("Duplicate compaction validation id");
        await appendLine(path, JSON.stringify({ kind: "validation", record: checked }));
      });
    },
    async get(validationId: string): Promise<Folded | null> {
      if (!isId(validationId)) return null;
      const found = (await readEntries(await registryPath(context.projectRoot))).get(validationId);
      return found ? { record: found.record, ...(found.compactionId !== undefined ? { compactionId: found.compactionId } : {}) } : null;
    },
    async acknowledge(validationId: string, compactionId: string) {
      if (!isId(validationId) || !isId(compactionId)) throw new Error("Invalid compaction acknowledgment");
      const path = await registryPath(context.projectRoot);
      await withLock(path, async () => {
        const entries = await readEntries(path);
        const found = entries.get(validationId);
        if (!found) throw new Error("Unknown compaction validation id");
        if (found.compactionId !== undefined) {
          if (found.compactionId === compactionId) return; // idempotent retry
          throw new Error("Compaction validation already consumed by a different compaction");
        }
        if (reverseBinding(entries, compactionId) !== null)
          throw new Error("Compaction already acknowledged under a different validation");
        await appendLine(path, JSON.stringify({ kind: "ack", validationId, compactionId }));
      });
    },
    async lookupCompaction(compactionId: string): Promise<string | null> {
      if (!isId(compactionId)) return null;
      return reverseBinding(await readEntries(await registryPath(context.projectRoot)), compactionId);
    },
  };
}

/** In-memory registry for contract tests and hosts with their own persistence. */
export function createMemoryCompactionRegistry(): CompactionRegistry {
  const entries = new Map<string, { record: CompactionValidationRecord; compactionId?: string }>();
  return {
    async save(record: CompactionValidationRecord) {
      const checked = validateRecord(record);
      if (entries.has(checked.validationId)) throw new Error("Duplicate compaction validation id");
      entries.set(checked.validationId, { record: checked });
    },
    async get(validationId: string): Promise<Folded | null> {
      const found = entries.get(validationId);
      return found ? { record: found.record, ...(found.compactionId !== undefined ? { compactionId: found.compactionId } : {}) } : null;
    },
    async acknowledge(validationId: string, compactionId: string) {
      const found = entries.get(validationId);
      if (!found) throw new Error("Unknown compaction validation id");
      if (found.compactionId !== undefined) {
        if (found.compactionId === compactionId) return;
        throw new Error("Compaction validation already consumed by a different compaction");
      }
      if (reverseBinding(entries, compactionId) !== null)
        throw new Error("Compaction already acknowledged under a different validation");
      found.compactionId = compactionId;
    },
    async lookupCompaction(compactionId: string): Promise<string | null> {
      return reverseBinding(entries, compactionId);
    },
  };
}
