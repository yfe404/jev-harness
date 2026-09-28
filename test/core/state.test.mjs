import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeProject, createFileStateService, classifyWritePath, canSendFileToJev, freezeRequest, clearRequestFreeze, getRequestState, createHarness } from '../../dist/index.js';
import { fixtureServices } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';
import { context } from '../support/fixtures.mjs';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'jev-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeProject(root, 'Keep the sample API stable.');
  return root;
}
test('project initialization is explicit and reads do not create state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-uninitialized-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createFileStateService();
  assert.equal(await state.read(context({ projectRoot: root })), null);
  await initializeProject(root, 'Build a greeting function.');
  assert.match((await state.read(context({ projectRoot: root }))).goal, /greeting/);
  await assert.rejects(initializeProject(root, 'new'), /EEXIST/);
  assert.equal(await state.read(context({ projectRoot: root, trusted: false })), null);
});
test('atomic revision checks and append-only evidence ledger', async t => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const service = createFileStateService();
  const initial = await service.read(ctx);
  const mutation = { kind: 'constraint', constraint: { id: 'c-1', createdAt: '2026-01-01', text: 'Do not add dependencies.' } };
  const concurrent = await Promise.allSettled([service.write(ctx, initial.revision, mutation), service.write(ctx, initial.revision, { ...mutation, constraint: { ...mutation.constraint, id: 'c-2' } })]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await service.read(ctx)).constraints.length, 1);
  const before = await service.read(ctx);
  const evidence = { id: 'e1', source: 'harness', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'one test passed', result: 'confirmed' };
  const withEvidence = await service.write(ctx, before.revision, { kind: 'evidence', evidence });
  const attempt = { id: 'a1', hypothesis: 'greeting works', method: 'npm test', result: 'inconclusive', evidenceIds: [], countsAsTrial: false };
  const withAttempt = await service.write(ctx, withEvidence.revision, { kind: 'attempt', attempt });
  const withResult = await service.write(ctx, withAttempt.revision, { kind: 'attempt-result', attemptId: 'a1', result: 'confirmed', evidenceIds: ['e1'] });
  assert.equal(withResult.attempts[0].countsAsTrial, true);
  assert.match(await readFile(join(root, '.harness', 'attempts.jsonl'), 'utf8'), /"kind":"attempt-result"/);
  await assert.rejects(service.write(ctx, withResult.revision, { kind: 'attempt-result', attemptId: 'a1', result: 'refuted', evidenceIds: ['e1'] }), /already/);
});
test('state corruption and credentials fail closed instead of being ignored', async t => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const service = createFileStateService();
  const state = await service.read(ctx);
  await assert.rejects(service.write(ctx, state.revision, { kind: 'constraint', constraint: { id: 'c-1', createdAt: '2026-01-01', text: 'My token ' + 'sk-' + 'or-v1-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' } }), /credential/);
  await writeFile(join(root, '.harness', 'attempts.jsonl'), '{bad json\n');
  await assert.rejects(service.read(ctx), /Malformed attempts/);
});
test('write gate protects canonical goal path and permits removing a leaked value', async t => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const fx = fixtureServices({ reply: responseFor() });
  const h = createHarness(fx.services, { mode: 'enforce' });
  const protectedWrite = await h.onToolPreflight({ context: ctx, callId: '1', intent: 'write', toolName: 'write', input: { path: '.harness/goal.md', content: 'agent edit' } });
  assert.equal(protectedWrite.appliedAction, 'block');
  const token = 'sk-' + 'or-v1-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const cleanup = await h.onToolPreflight({ context: ctx, callId: '2', intent: 'edit', toolName: 'edit',
    input: { path: 'src/config.ts', edits: [{ oldText: token, newText: 'process.env.MY_KEY' }] } });
  assert.equal(cleanup.appliedAction, 'allow');
  assert.equal(JSON.stringify(fx.requests).includes(token), false);
});

test('canonical aliases, private inputs, and per-request correction locks', async t => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  await symlink(join(root, '.harness', 'goal.md'), join(root, 'goal-link.md'));
  assert.equal(await classifyWritePath(root, 'goal-link.md'), 'protected');
  assert.equal(await classifyWritePath(root, '../outside.md'), 'outside');
  assert.equal(await classifyWritePath(root, 'src/new.ts'), 'ordinary');
  await writeFile(join(root, '.env'), 'SECRET=private');
  await symlink(join(root, '.env'), join(root, 'visible.txt'));
  assert.equal(await canSendFileToJev(root, 'visible.txt'), false);
  assert.deepEqual(await getRequestState(ctx), { frozen: false, planReviewed: false });
  await freezeRequest(ctx);
  assert.equal((await getRequestState(ctx)).frozen, true);
  assert.equal((await getRequestState(context({ ...ctx, requestId: 'next-request' }))).frozen, true);
  await clearRequestFreeze(context({ ...ctx, requestId: 'next-request' }));
  assert.equal((await getRequestState(ctx)).frozen, true); // another request cannot clear this correction
  await clearRequestFreeze(ctx);
  assert.equal((await getRequestState(ctx)).frozen, false);
  assert.equal((await getRequestState(context({ ...ctx, requestId: 'next-request' }))).frozen, false);
});
