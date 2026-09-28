import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, realpath, rename, lstat, stat } from "node:fs/promises";
import { join, relative, resolve, sep, dirname, basename } from "node:path";
import type { Attempt, CompactionCycle, EventContext, Evidence, StandingConstraint, StateMutation, StateService, StateSnapshot, TypedCheckpoint } from "../contracts.js";
import { targetEvidenceMark } from "../compaction.js";
import { isPrivatePath } from "../redact.js";
import { MAX_CONSTRAINTS, MAX_GOAL, MAX_LEDGER, MAX_SUMMARY, plainRecord, validateAttempt, validateCheckpoint, validateConstraint, validateEvidence, validateGoal, validateMutation } from "./schema.js";

const names = ["goal.md", "constraints.md", "attempts.jsonl", "summary.json"] as const;
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function regular(path: string, max: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > max) throw new Error(`Invalid or oversized state file: ${basename(path)}`);
  return readFile(path, "utf8");
}
async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("State directory must be a real directory");
}
async function base(root: string): Promise<string> {
  const real = await realpath(root);
  await directory(real);
  return join(real, ".harness");
}

export interface InitializedProject { readonly directory: string; readonly state: StateSnapshot }
/** Explicit owner operation: never called by event preflight or by project import. */
export async function initializeProject(projectRoot: string, goal: string): Promise<InitializedProject> {
  const g = validateGoal(goal);
  const dir = await base(projectRoot);
  await mkdir(dir, { mode: 0o755 }); // EEXIST is an error; no implicit overwrite.
  await createExclusive(join(dir, "goal.md"), `${g.trimEnd()}\n`);
  await createExclusive(join(dir, "constraints.md"), "# Standing constraints (owner instructions captured verbatim)\n");
  await createExclusive(join(dir, "attempts.jsonl"), "");
  await createExclusive(join(dir, "summary.json"), JSON.stringify({ checkpoint: null, compactionIds: [] }, null, 2) + "\n");
  await createExclusive(join(dir, ".gitignore"), "/runtime/\n/audit/\n");
  const state = await readProject(projectRoot);
  if (!state) throw new Error("Initialization did not create state");
  return { directory: dir, state };
}
async function createExclusive(path: string, content: string): Promise<void> {
  const fd = await open(path, "wx", 0o644);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
}

/** null only for fully absent `.harness/`; missing files in an existing dir are corruption. */
export async function readProject(projectRoot: string): Promise<StateSnapshot | null> {
  const dir = await base(projectRoot);
  if (!(await exists(dir))) return null;
  await directory(dir);
  const contents = await Promise.all(names.map(async name => {
    const max = name === "goal.md" ? MAX_GOAL + 2 : name === "constraints.md" ? MAX_CONSTRAINTS : name === "attempts.jsonl" ? MAX_LEDGER : MAX_SUMMARY;
    return regular(join(dir, name), max);
  }));
  const [goalRaw, constraintRaw, ledgerRaw, summaryRaw] = contents as [string, string, string, string];
  const goal = validateGoal(goalRaw.trim());
  const constraints: StandingConstraint[] = [];
  for (const line of constraintRaw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(c-[A-Za-z0-9_-]+) \((\d{4}-\d\d-\d\d)\): (.*)$/.exec(line);
    if (!match) throw new Error("Malformed constraints.md");
    const rule = validateConstraint({ id: match[1], createdAt: match[2], text: match[3] });
    if (constraints.some(existing => existing.id === rule.id)) throw new Error("Duplicate constraint id");
    constraints.push(rule);
  }
  const attempts: Attempt[] = [];
  const evidence: Evidence[] = [];
  for (const line of ledgerRaw.split("\n")) {
    if (!line) continue;
    let item: unknown;
    try { item = JSON.parse(line); } catch { throw new Error("Malformed attempts.jsonl"); }
    if (!plainRecord(item)) throw new Error("Malformed attempts.jsonl record");
    if (item.kind === "attempt") {
      const a = validateAttempt(item.attempt);
      validateMutation({ kind: "attempt", attempt: a });
      if (attempts.some(old => old.id === a.id)) throw new Error("Duplicate attempt id");
      attempts.push(a);
    } else if (item.kind === "evidence") {
      const e = validateEvidence(item.evidence);
      if (evidence.some(old => old.id === e.id)) throw new Error("Duplicate evidence id");
      evidence.push(e);
    } else if (item.kind === "attempt-result") {
      const attempt = attempts.find(a => a.id === item.attemptId);
      if (!attempt || !["confirmed", "refuted", "inconclusive", "setup_failure"].includes(String(item.result)) ||
          !Array.isArray(item.evidenceIds) || item.evidenceIds.some(v => typeof v !== "string" || !evidence.some(e => e.id === v))) throw new Error("Invalid attempt result record");
      const cited = item.evidenceIds.map((id: string) => evidence.find(e => e.id === id));
      if (!cited.length || cited.some(e => e?.source !== "harness" || e.result !== item.result || e.method !== attempt.method))
        throw new Error("Attempt result has no matching observed harness evidence");
      const update = validateAttempt({ ...attempt, result: item.result, evidenceIds: item.evidenceIds,
        countsAsTrial: item.result !== "setup_failure" });
      attempts[attempts.indexOf(attempt)] = update;
    } else throw new Error("Unknown attempts.jsonl record");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(summaryRaw); } catch { throw new Error("Malformed summary.json"); }
  if (!plainRecord(parsed) || !Array.isArray(parsed.compactionIds) || parsed.compactionIds.length > 10_000 ||
      parsed.compactionIds.some((v: unknown) => typeof v !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(v)) ||
      new Set(parsed.compactionIds).size !== parsed.compactionIds.length) throw new Error("Malformed summary.json");
  const compactionIds = parsed.compactionIds as string[];
  let compactionCycles: CompactionCycle[];
  if (parsed.compactionCycles === undefined) {
    // Legacy file: cycles recorded before evidence-mark tracking never count as stagnant.
    compactionCycles = compactionIds.map(id => ({ id, evidence: null }));
  } else {
    if (!Array.isArray(parsed.compactionCycles) || parsed.compactionCycles.length !== compactionIds.length) throw new Error("Malformed summary.json");
    compactionCycles = parsed.compactionCycles.map((cycle: unknown, index: number) => {
      if (!plainRecord(cycle) || cycle.id !== compactionIds[index] ||
          (cycle.evidence !== null && (typeof cycle.evidence !== "string" || !/^[0-9a-f]{64}$/.test(cycle.evidence))))
        throw new Error("Malformed summary.json");
      return { id: cycle.id as string, evidence: cycle.evidence as string | null };
    });
  }
  const checkpoint: TypedCheckpoint | null = parsed.checkpoint === null ? null : validateCheckpoint(parsed.checkpoint);
  if (parsed.checkpointAcks !== undefined &&
      (!Array.isArray(parsed.checkpointAcks) || parsed.checkpointAcks.length > 10_000 ||
       parsed.checkpointAcks.some((v: unknown) => typeof v !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(v)) ||
       new Set(parsed.checkpointAcks).size !== parsed.checkpointAcks.length)) throw new Error("Malformed summary.json");
  const checkpointAcks = (parsed.checkpointAcks ?? []) as string[];
  return {
    revision: hash(contents.join("\u0000")), goal, constraints, attempts, evidence,
    summary: checkpoint, compactionIds, compactionCycles, checkpointAcks,
  };
}

/** Avoid following aliases to a protected harness file or outside the trusted root. */
export async function classifyWritePath(projectRoot: string, requested: string): Promise<"protected" | "outside" | "ordinary"> {
  const root = await realpath(projectRoot);
  const target = resolve(root, requested.replace(/^@/, ""));
  let cursor = target;
  const suffix: string[] = [];
  while (!(await exists(cursor))) {
    suffix.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) return "outside";
    cursor = parent;
  }
  const canonical = resolve(await realpath(cursor), ...suffix);
  const rel = relative(root, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return "outside";
  if (rel === ".harness" || rel.startsWith(`.harness${sep}`)) return "protected";
  return "ordinary";
}
export async function canSendFileToJev(projectRoot: string, requested: string): Promise<boolean> {
  const classification = await classifyWritePath(projectRoot, requested);
  if (classification !== "ordinary" || isPrivatePath(requested)) return false;
  const candidate = resolve(await realpath(projectRoot), requested.replace(/^@/, ""));
  if (!(await exists(candidate))) return false;
  return !isPrivatePath(await realpath(candidate));
}

async function atomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(temp, "wx", 0o600);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
  try { await rename(temp, path); }
  catch (error) { const { unlink } = await import("node:fs/promises"); await unlink(temp).catch(() => {}); throw error; }
  const dir = await open(dirname(path), "r");
  try { await dir.sync(); } finally { await dir.close(); }
}
async function appendDurable(path: string, line: string): Promise<void> {
  const fd = await open(path, "a");
  try { await fd.writeFile(line); await fd.sync(); } finally { await fd.close(); }
}
async function withLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const runtime = join(dir, "runtime");
  if (await exists(runtime)) await directory(runtime);
  else {
    try { await mkdir(runtime, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await directory(runtime); }
  }
  const lock = join(runtime, "state.lock");
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  for (let n = 0; n < 50; n++) {
    try { fd = await open(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (n === 49) throw new Error("State is locked by another process; retry or ask the owner");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!fd) throw new Error("Could not lock state");
  try { return await task(); }
  finally {
    await fd.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(lock);
  }
}

export function createFileStateService(): StateService {
  return {
    async read(ctx) { return ctx.trusted ? readProject(ctx.projectRoot) : null; },
    async write(ctx: EventContext, expectedRevision: string, mutation: StateMutation) {
      if (!ctx.trusted) throw new Error("Untrusted project cannot mutate harness state");
      validateMutation(mutation);
      const dir = await base(ctx.projectRoot);
      if (!(await exists(dir))) throw new Error("Project is not initialized");
      await directory(dir);
      return withLock(dir, async () => {
        const previous = await readProject(ctx.projectRoot);
        if (!previous || previous.revision !== expectedRevision) throw new Error("State revision conflict");
        switch (mutation.kind) {
          case "constraint": {
            if (previous.constraints.some(c => c.id === mutation.constraint.id)) throw new Error("Duplicate constraint id");
            if (previous.constraints.some(c => c.text === mutation.constraint.text)) return previous;
            const line = `${mutation.constraint.id} (${mutation.constraint.createdAt}): ${mutation.constraint.text}\n`;
            if (Buffer.byteLength(line) + Buffer.byteLength(await regular(join(dir, "constraints.md"), MAX_CONSTRAINTS)) > MAX_CONSTRAINTS) throw new Error("Constraints exceed size limit");
            await appendDurable(join(dir, "constraints.md"), line);
            break;
          }
          case "attempt": {
            if (previous.attempts.some(a => a.id === mutation.attempt.id)) throw new Error("Duplicate attempt id");
            if (mutation.attempt.evidenceIds.some(id => !previous.evidence.some(e => e.id === id))) throw new Error("Unobserved attempt evidence");
            await appendLedger(dir, { kind: "attempt", attempt: mutation.attempt });
            break;
          }
          case "evidence": {
            if (previous.evidence.some(e => e.id === mutation.evidence.id)) throw new Error("Duplicate evidence id");
            await appendLedger(dir, { kind: "evidence", evidence: mutation.evidence });
            break;
          }
          case "attempt-result": {
            const target = previous.attempts.find(a => a.id === mutation.attemptId);
            if (!target) throw new Error("Unknown attempt");
            if (target.countsAsTrial || target.result !== "inconclusive") throw new Error("Attempt already has a recorded result");
            if (!mutation.evidenceIds.length || mutation.evidenceIds.some(id => !previous.evidence.some(e =>
              e.id === id && e.source === "harness" && e.result === mutation.result && e.method === target.method)))
              throw new Error("Attempt result requires matching observed harness evidence");
            await appendLedger(dir, mutation);
            break;
          }
          case "checkpoint": {
            const priorAcks = previous.checkpointAcks ?? [];
            // The application marker is written atomically with the checkpoint, so
            // a replayed acknowledgment can never republish a historical checkpoint.
            if (mutation.appliedValidationId !== undefined && priorAcks.includes(mutation.appliedValidationId)) return previous;
            const checkpointAcks = mutation.appliedValidationId === undefined ? priorAcks : [...priorAcks, mutation.appliedValidationId];
            await atomic(join(dir, "summary.json"), JSON.stringify({ checkpoint: mutation.checkpoint,
              compactionIds: previous.compactionIds, compactionCycles: previous.compactionCycles, checkpointAcks }, null, 2) + "\n");
            break;
          }
          case "compaction-ack": {
            const priorAcks = previous.checkpointAcks ?? [];
            // Single atomic application: counter/cycle, merged checkpoint, and the
            // durable application marker are written together, so a replayed
            // acknowledgment is a pure no-op and an interrupted one recovers as
            // exactly one compare-and-swap against the validated revision.
            if (priorAcks.includes(mutation.validationId)) return previous;
            const count = mutation.countEvidence !== false && !previous.compactionIds.includes(mutation.compactionId);
            // Bind the cycle to the target-evidence mark at acknowledgment time so
            // stagnation survives reload and resets only on new confirmed/refuted evidence.
            const cycles = previous.compactionCycles ?? previous.compactionIds.map(id => ({ id, evidence: null }));
            await atomic(join(dir, "summary.json"), JSON.stringify({ checkpoint: mutation.checkpoint ?? previous.summary,
              compactionIds: count ? [...previous.compactionIds, mutation.compactionId] : previous.compactionIds,
              compactionCycles: count ? [...cycles, { id: mutation.compactionId, evidence: targetEvidenceMark(previous) }] : cycles,
              checkpointAcks: [...priorAcks, mutation.validationId] }, null, 2) + "\n");
            break;
          }
        }
        const next = await readProject(ctx.projectRoot);
        if (!next) throw new Error("State disappeared after write");
        return next;
      });
    },
  };
}
async function appendLedger(dir: string, value: unknown): Promise<void> {
  const line = JSON.stringify(value) + "\n";
  const path = join(dir, "attempts.jsonl");
  if (Buffer.byteLength(line) + (await stat(path)).size > MAX_LEDGER) throw new Error("Attempt ledger exceeds size limit");
  await appendDurable(path, line);
}
