import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { EventContext, RuntimeService } from "../contracts.js";

export interface RequestState { readonly frozen: boolean; readonly planReviewed: boolean }
const initial: RequestState = { frozen: false, planReviewed: false };

function key(ctx: EventContext): string {
  return createHash("sha256").update(JSON.stringify([ctx.host, ctx.projectRoot, ctx.sessionId, ctx.requestId])).digest("hex");
}
function sessionKey(ctx: EventContext): string {
  return createHash("sha256").update(JSON.stringify([ctx.host, ctx.projectRoot, ctx.sessionId])).digest("hex");
}
function ownerKey(ctx: EventContext): string { return createHash("sha256").update(ctx.requestId).digest("hex"); }
async function runtime(ctx: EventContext): Promise<string> {
  if (!ctx.trusted) throw new Error("Untrusted project cannot create runtime state");
  const root = await realpath(ctx.projectRoot);
  const dir = join(root, ".harness");
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Project is not initialized");
  const path = join(dir, "runtime");
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe runtime directory");
  }
  return path;
}
async function readOwnRequestState(ctx: EventContext): Promise<RequestState> {
  if (!ctx.trusted) return initial;
  const path = join(await runtime(ctx), `${key(ctx)}.json`);
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
  const path = join(await runtime(ctx), `${sessionKey(ctx)}.freeze.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256) throw new Error("Unsafe session freeze state");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("owner" in parsed) || typeof parsed.owner !== "string" || !/^[0-9a-f]{64}$/.test(parsed.owner))
      throw new Error("Corrupt session freeze state");
    return { ...state, frozen: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return state;
    throw error;
  }
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
async function sessionFreeze(ctx: EventContext, frozen: boolean): Promise<void> {
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
    if (frozen) {
      const temp = `${path}.${randomUUID()}.tmp`;
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ owner: ownerKey(ctx) })); await file.sync(); } finally { await file.close(); }
      try { await rename(temp, path); }
      catch (error) { await unlink(temp).catch(() => {}); throw error; }
    } else {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 256) throw new Error("Unsafe session freeze state");
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || !("owner" in parsed) || typeof parsed.owner !== "string") throw new Error("Corrupt session freeze state");
        if (parsed.owner === ownerKey(ctx)) await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } finally { await fd.close(); await unlink(guard); }
}
/** A correction freezes tools for every concurrent request in this session. Only its owner can clear it. */
export async function freezeRequest(ctx: EventContext): Promise<void> {
  await sessionFreeze(ctx, true); // Fail closed if the second write is interrupted.
  await update(ctx, { frozen: true });
}
export async function clearRequestFreeze(ctx: EventContext): Promise<void> {
  await update(ctx, { frozen: false });
  await sessionFreeze(ctx, false);
}
export async function markPlanReviewed(ctx: EventContext): Promise<void> { await update(ctx, { planReviewed: true }); }
export function createFileRuntimeService(): RuntimeService {
  return { get: getRequestState, freeze: freezeRequest, clear: clearRequestFreeze, markPlanReviewed };
}
