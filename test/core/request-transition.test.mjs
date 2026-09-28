import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acceptNewUserRequest, createFileRuntimeService, createFileStateService, createHarness,
  freezeRequest, getRequestState, initializeProject,
} from '../../dist/index.js';
import { context, fixtureServices } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'jev-transition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeProject(root, 'Keep a sample API stable.');
  return root;
}
function harness(root, options = {}) {
  const fx = fixtureServices({ reply: options.reply ?? responseFor(), auditFails: options.auditFails });
  return { fx, h: createHarness({ ...fx.services, state: createFileStateService(), runtime: createFileRuntimeService() }, { mode: options.mode ?? 'enforce' }) };
}
function accepted(ctx, overrides = {}) { return { context: ctx, source: 'user', accepted: true, ...overrides }; }

 test('only an accepted authentic request can release a correction; retries and reload cannot', async t => {
  const root = await project(t);
  const a = context({ projectRoot: root, requestId: 'correction' });
  const b = context({ projectRoot: root, requestId: 'next-request' });
  const otherSession = context({ projectRoot: root, sessionId: 'other', requestId: 'other-correction' });
  const { h } = harness(root);
  assert.equal((await h.acceptUserRequest(accepted(a))).fresh, true);
  await freezeRequest(a);
  await freezeRequest(otherSession);
  assert.equal((await h.acceptUserRequest(accepted(a))).fresh, false);
  assert.equal((await getRequestState(b)).frozen, true);
  const invalid = await h.acceptUserRequest(accepted(b, { source: 'extension' }));
  assert.equal(invalid.decision.appliedAction, 'escalate');
  assert.equal(invalid.fresh, false);
  assert.equal((await getRequestState(b)).frozen, true);
  // Construct a new instance as on hook-process restart: the accepted IDs are on disk.
  const restarted = harness(root).h;
  const transition = await restarted.acceptUserRequest(accepted(b));
  assert.equal(transition.fresh, true);
  assert.equal(transition.releasedPriorFreeze, true);
  assert.equal((await getRequestState(b)).frozen, false);
  assert.equal((await getRequestState(a)).frozen, true); // old automatic handoff cannot resume
  assert.equal((await getRequestState(otherSession)).frozen, true);
  await freezeRequest(b);
  assert.equal((await restarted.acceptUserRequest(accepted(a))).fresh, false);
  await freezeRequest(a); // even an accidental stale retry cannot steal the new freeze
  assert.equal((await getRequestState(b)).frozen, true);
});

 test('concurrent acceptance is exactly once; legacy locks survive upgrade', async t => {
  const root = await project(t);
  const a = context({ projectRoot: root, sessionId: 'legacy', requestId: 'old' });
  const b = context({ ...a, requestId: 'new' });
  const sessionHash = createHash('sha256').update(JSON.stringify([a.host, a.projectRoot, a.sessionId])).digest('hex');
  const ownerHash = createHash('sha256').update(a.requestId).digest('hex');
  await mkdir(join(root, '.harness', 'runtime'));
  await writeFile(join(root, '.harness', 'runtime', `${sessionHash}.freeze.json`), JSON.stringify({ owner: ownerHash }));
  assert.equal((await getRequestState(b)).frozen, true);
  const [left, right] = await Promise.all([acceptNewUserRequest(b), acceptNewUserRequest(b)]);
  assert.deepEqual([left.fresh, right.fresh].sort(), [false, true]);
  assert.equal((await getRequestState(b)).frozen, false);
  assert.equal((await getRequestState(a)).frozen, true);
});

 test('audit failure, shadow, and uninitialized or untrusted projects do not advance locks', async t => {
  const root = await project(t);
  const a = context({ projectRoot: root, requestId: 'stop' });
  const b = context({ projectRoot: root, requestId: 'new' });
  await freezeRequest(a);
  const failing = harness(root, { auditFails: true }).h;
  assert.equal((await failing.acceptUserRequest(accepted(b))).decision.appliedAction, 'escalate');
  assert.equal((await getRequestState(b)).frozen, true);
  const shadow = harness(root, { mode: 'shadow' }).h;
  const observation = await shadow.acceptUserRequest(accepted(b));
  assert.equal(observation.decision.appliedAction, 'none');
  assert.equal(observation.releasedPriorFreeze, false);
  assert.equal((await getRequestState(b)).frozen, true);
  assert.equal((await harness(root).h.acceptUserRequest(accepted({ ...b, trusted: false }))).decision.status, 'inert');
  const empty = await mkdtemp(join(tmpdir(), 'jev-inert-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal((await harness(root).h.acceptUserRequest(accepted({ ...b, projectRoot: empty }))).decision.status, 'inert');
});

 test('a corrupt session lock cannot be treated as an unlocked request', async t => {
  const root = await project(t);
  const a = context({ projectRoot: root, requestId: 'correction' });
  const b = context({ projectRoot: root, requestId: 'next' });
  await freezeRequest(a);
  const sessionHash = createHash('sha256').update(JSON.stringify([a.host, a.projectRoot, a.sessionId])).digest('hex');
  await writeFile(join(root, '.harness', 'runtime', `${sessionHash}.freeze.json`), '{}');
  const outcome = await harness(root).h.acceptUserRequest(accepted(b));
  assert.equal(outcome.decision.appliedAction, 'escalate');
  assert.equal(outcome.fresh, false);
  await assert.rejects(getRequestState(b), /Corrupt/);
});

test('a detected correction stays frozen until a different accepted user request', async t => {
  const root = await project(t);
  const a = context({ projectRoot: root, requestId: 'correction' });
  const b = context({ projectRoot: root, requestId: 'resume' });
  const replies = responseFor({ noul: { 'g5-stop_stop_or_correct': 0.95 }, choice: { 'g4-capture_kind': 'feedback' } });
  const { h } = harness(root, { reply: replies });
  assert.equal((await h.acceptUserRequest(accepted(a))).fresh, true);
  assert.equal((await h.onUserInput({ context: a, text: 'Stop editing. Explain first.', source: 'user' })).appliedAction, 'freeze');
  assert.equal((await getRequestState(b)).frozen, true);
  assert.equal((await h.onToolPreflight({ context: a, callId: '1', intent: 'read', toolName: 'read', input: { path: 'src/x.ts' } })).appliedAction, 'block');
  assert.equal((await h.acceptUserRequest(accepted(b))).releasedPriorFreeze, true);
  assert.equal((await getRequestState(a)).frozen, true);
  assert.equal((await getRequestState(b)).frozen, false);
});

 test('shadow preflight and acceptance do not create runtime files', async t => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const fx = fixtureServices({ reply: responseFor() });
  const h = createHarness({ ...fx.services, state: createFileStateService(), runtime: createFileRuntimeService() });
  assert.equal((await h.acceptUserRequest(accepted(ctx))).decision.appliedAction, 'none');
  await h.onToolPreflight({ context: ctx, callId: '1', intent: 'read', toolName: 'read', input: { path: 'src/index.ts' } });
  await assert.rejects(lstat(join(root, '.harness', 'runtime')), { code: 'ENOENT' });
});

test('every later write and shell action receives G6 review after a harmless first read', async t => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const state = createFileStateService();
  const initial = await state.read(ctx);
  await state.write(ctx, initial.revision, { kind: 'constraint', constraint: {
    id: 'c-1', createdAt: '2026-01-02', text: 'Do not add dependencies.',
  } });
  const fx = fixtureServices({ reply: req => responseFor({
    choice: {
      'g6-plan_violates': req.state['g6-plan']?.action.tool === 'write' ? 'c-1' : 'none',
      'g6-plan_relation_to_goal': 'direct', 'g1-bash_effect': 'long_lived',
    },
  })(req) });
  const runtime = createFileRuntimeService();
  const h = createHarness({ ...fx.services, state, runtime }, { mode: 'enforce' });
  const read = await h.onToolPreflight({ context: ctx, callId: '1', intent: 'read', toolName: 'read', input: { path: 'src/index.ts' } });
  assert.equal(read.appliedAction, 'allow');
  assert.equal((await runtime.get(ctx)).planReviewed, true);
  const write = await h.onToolPreflight({ context: ctx, callId: '2', intent: 'write', toolName: 'write', input: { path: 'src/index.ts', content: 'import x from "new-library";' } });
  assert.equal(write.appliedAction, 'block');
  assert.match(write.reason, /c-1/);
  const shell = await h.onToolPreflight({ context: ctx, callId: '3', intent: 'shell', toolName: 'bash', input: { command: 'npm run dev' } });
  assert.equal(shell.appliedAction, 'confirm');
  assert.ok(fx.requests.at(-1).questions['g6-plan_violates']);
  assert.ok(fx.requests.at(-1).questions['g1-bash_effect']);
  const observed = fixtureServices({ reply: responseFor() });
  const shadowRuntime = createFileRuntimeService();
  const other = context({ ...ctx, sessionId: 'shadow' });
  const shadow = createHarness({ ...observed.services, state, runtime: shadowRuntime }, { mode: 'shadow' });
  await shadow.onToolPreflight({ context: other, callId: '4', intent: 'read', toolName: 'read', input: { path: 'src/index.ts' } });
  assert.equal((await shadowRuntime.get(other)).planReviewed, false);
});
