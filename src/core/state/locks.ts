import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventContext, RuntimeService } from "../contracts.js";

export interface RequestState { readonly frozen: boolean; readonly planReviewed: boolean }
export interface AcceptedRequestState { readonly fresh: boolean; readonly releasedPriorFreeze: boolean }
const initial: RequestState = { frozen: false, planReviewed: false };
const MAX_ACCEPTED = 1024;
interface SessionState { owner?: string; accepted: string[]; lastAccepted?: string; frozenRequests: string[] }
const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function key(ctx: EventContext): string {
  return createHash("sha256").update(JSON.stringify([ctx.host, ctx.projectRoot, ctx.sessionId, ctx.requestId])).digest("hex");
}
function sessionKey(ctx: EventContext): string {
  return createHash("sha256").update(JSON.stringify([ctx.host, ctx.projectRoot, ctx.sessionId])).digest("hex");
}
function ownerKey(ctx: EventContext): string { return createHash("sha256").update(ctx.requestId).digest("hex"); }
async function runtime(ctx: EventContext, create = true): Promise<string> {
  if (!ctx.trusted) throw new Error("Untrusted project cannot create runtime state");
  const root = await realpath(ctx.projectRoot);
  const dir = join(root, ".harness");
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Project is not initialized");
  const path = join(dir, "runtime");
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe runtime directory");
  } catch (error) {
    if (create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
}
async function readOwnRequestState(ctx: EventContext): Promise<RequestState> {
  if (!ctx.trusted) return initial;
  const path = join(await runtime(ctx, false), `${key(ctx)}.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error("Unsafe request state");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !('frozen' in parsed) || !('planReviewed' in parsed) ||
      typeof parsed.frozen !== "boolean" || typeof parsed.planReviewed !== "boolean") throw new Error("Corrupt request state");
    return { frozen: parsed.frozen, planReviewed: parsed.planReviewed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial;
    throw error;
  }
}
export async function getRequestState(ctx: EventContext): Promise<RequestState> {
  if (!ctx.trusted) return initial;
  const state = await readOwnRequestState(ctx);
  const session = await readSessionState(join(await runtime(ctx, false), `${sessionKey(ctx)}.freeze.json`));
  return { ...state, frozen: state.frozen || session.owner !== undefined || session.frozenRequests.includes(ownerKey(ctx)) };
}
async function update(ctx: EventContext, patch: Partial<RequestState>): Promise<RequestState> {
  const dir = await runtime(ctx);
  const path = join(dir, `${key(ctx)}.json`);
  const guard = `${path}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let n = 0; n < 50; n++) {
    try { lock = await open(guard, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (n === 49) throw new Error("Request state locked by another process");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!lock) throw new Error("Could not lock request state");
  try {
    const next = { ...await readOwnRequestState(ctx), ...patch };
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = await open(temp, "wx", 0o600);
    try { await fd.writeFile(JSON.stringify(next)); await fd.sync(); } finally { await fd.close(); }
    try { await rename(temp, path); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
    return next;
  } finally { await lock.close(); await unlink(guard); }
}
async function readSessionState(path: string): Promise<SessionState> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 150_000) throw new Error("Unsafe session freeze state");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Corrupt session freeze state");
    const value = parsed as { owner?: unknown; accepted?: unknown; lastAccepted?: unknown; frozenRequests?: unknown };
    if (value.owner === undefined && value.accepted === undefined) throw new Error("Corrupt session freeze state");
    // An older lock contains only {owner}; preserve its freeze on upgrade.
    if (value.owner !== undefined && !isHash(value.owner)) throw new Error("Corrupt session freeze owner");
    const accepted = value.accepted ?? [];
    if (!Array.isArray(accepted) || accepted.length > MAX_ACCEPTED || !accepted.every(isHash) || new Set(accepted).size !== accepted.length)
      throw new Error("Corrupt accepted request list");
    if (value.lastAccepted !== undefined && (!isHash(value.lastAccepted) || !accepted.includes(value.lastAccepted)))
      throw new Error("Corrupt last accepted request");
    const frozenRequests = value.frozenRequests ?? (value.owner ? [value.owner] : []);
    if (!Array.isArray(frozenRequests) || frozenRequests.length > MAX_ACCEPTED || !frozenRequests.every(isHash) || new Set(frozenRequests).size !== frozenRequests.length)
      throw new Error("Corrupt frozen request list");
    return { ...(value.owner ? { owner: value.owner } : {}), accepted, frozenRequests,
      ...(value.lastAccepted ? { lastAccepted: value.lastAccepted } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accepted: [], frozenRequests: [] };
    throw error;
  }
}

async function updateSession(ctx: EventContext, mutate: (state: SessionState) => SessionState): Promise<void> {
  const path = join(await runtime(ctx), `${sessionKey(ctx)}.freeze.json`);
  const guard = `${path}.lock`;
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  for (let n = 0; n < 50; n++) {
    try { fd = await open(guard, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (n === 49) throw new Error("Session freeze lock is busy");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!fd) throw new Error("Could not lock session freeze");
  try {
    const next = mutate(await readSessionState(path));
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
    try { await rename(temp, path); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fd.close(); await unlink(guard); }
}

/** Record host acceptance before invoking onUserInput. A retried request cannot release a later freeze. */
export async function acceptNewUserRequest(ctx: EventContext): Promise<AcceptedRequestState> {
  let result: AcceptedRequestState = { fresh: false, releasedPriorFreeze: false };
  await updateSession(ctx, state => {
    const id = ownerKey(ctx);
    if (state.accepted.includes(id)) return state;
    if (state.accepted.length === MAX_ACCEPTED) throw new Error("Accepted request history full; start a new session");
    const releasedPriorFreeze = state.owner !== undefined && state.owner !== id;
    result = { fresh: true, releasedPriorFreeze };
    return { ...state, accepted: [...state.accepted, id], lastAccepted: id,
      owner: releasedPriorFreeze ? undefined : state.owner };
  });
  return result;
}
/** Freeze this request; an older retry cannot resurrect a superseded correction. */
export async function freezeRequest(ctx: EventContext): Promise<void> {
  await updateSession(ctx, state => {
    const id = ownerKey(ctx);
    if (state.lastAccepted && state.lastAccepted !== id && state.accepted.includes(id)) return state;
    if (!state.frozenRequests.includes(id) && state.frozenRequests.length === MAX_ACCEPTED)
      throw new Error("Frozen request history full; start a new session");
    return { ...state, owner: id, frozenRequests: state.frozenRequests.includes(id)
      ? state.frozenRequests : [...state.frozenRequests, id] };
  });
}
/** Explicit owner reset only; never call from Stop, turn_end, settlement or queued input. */
export async function clearRequestFreeze(ctx: EventContext): Promise<void> {
  await updateSession(ctx, state => ({ ...state, owner: state.owner === ownerKey(ctx) ? undefined : state.owner,
    frozenRequests: state.frozenRequests.filter(id => id !== ownerKey(ctx)) }));
  await update(ctx, { frozen: false });
}
export async function markPlanReviewed(ctx: EventContext): Promise<void> { await update(ctx, { planReviewed: true }); }
export function createFileRuntimeService(): RuntimeService {
  return { get: getRequestState, accept: acceptNewUserRequest, freeze: freezeRequest, clear: clearRequestFreeze, markPlanReviewed };
}
