import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFileAuditService, createFileCompactionRegistry, createFileStateService, createHarness,
  initializeProject,
} from '../../dist/index.js';
import { context } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'jev-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeProject(root, 'Keep a sample API stable.');
  return root;
}
const record = (overrides = {}) => ({
  validationId: 'v-test1', host: 'cli', projectHash: 'a'.repeat(64), sessionHash: 'b'.repeat(64),
  requestHash: 'c'.repeat(64), mode: 'enforce', stateRevision: 'rev-1', candidateHash: 'd'.repeat(64),
  createdAt: '2026-01-02T00:00:00.000Z', ...overrides,
});

test('file registry is durable across reload and rejects duplicate ids and conflicting acks', async (t) => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const registry = createFileCompactionRegistry(ctx);
  const entry = record({ projectHash: sha(root), sessionHash: sha(ctx.sessionId), requestHash: sha(ctx.requestId) });
  await registry.save(entry);
  await assert.rejects(() => registry.save(entry), /Duplicate compaction validation id/);
  await registry.acknowledge('v-test1', 'cmp-1');
  await registry.acknowledge('v-test1', 'cmp-1'); // idempotent retry
  await assert.rejects(() => registry.acknowledge('v-test1', 'cmp-2'), /different compaction/);
  await assert.rejects(() => registry.acknowledge('v-unknown', 'cmp-1'), /Unknown compaction validation id/);
  // A fresh instance (process reload) sees the same folded state.
  const reloaded = createFileCompactionRegistry(ctx);
  const folded = await reloaded.get('v-test1');
  assert.equal(folded.compactionId, 'cmp-1');
  assert.equal(folded.record.stateRevision, 'rev-1');
  assert.equal(await reloaded.get('v-nothing'), null);
});

test('file registry refuses foreign records and fails closed on corruption', async (t) => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const registry = createFileCompactionRegistry(ctx);
  await assert.rejects(() => registry.save(record()), /does not belong to this project or host/);
  await assert.rejects(() => registry.save(record({ host: 'pi' })), /does not belong/);
  const path = join(root, '.harness', 'runtime', 'compactions.jsonl');
  await mkdir(join(root, '.harness', 'runtime'), { recursive: true });
  await writeFile(path, '{"kind":"ack","validationId":"v-x","compactionId":"c-1"}\n');
  await assert.rejects(() => registry.get('v-x'), /acknowledgment without a validation/);
  await writeFile(path, 'not json\n');
  await assert.rejects(() => registry.get('v-x'), /Corrupt compaction registry/);
});

test('createHarness defaults to the durable file registry and survives a full reload', async (t) => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const make = () => createHarness({
    provider: { async decide(request) { return responseFor()(request); } },
    state: createFileStateService(),
    audit: createFileAuditService(ctx),
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  }, { mode: 'enforce', evidenceWorkflow: true });
  const event = { context: ctx, summaryText: 'Stable API kept; one observed test passes.', reason: 'threshold' };
  const { decision, retainedPolicyBlock } = await make().validateCompaction(event);
  assert.equal(decision.appliedAction, 'allow');
  assert.match(decision.validationId, /^v-/);
  assert.match(retainedPolicyBlock, /Goal: Keep a sample API stable\./);
  const ack = await make().acknowledgeCompaction({ context: ctx, compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(ack.appliedAction, 'allow');
  // Reload: counter and registry binding persist; a replayed ack counts nothing.
  const reloaded = make();
  const replay = await reloaded.acknowledgeCompaction({ context: ctx, compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(replay.appliedAction, 'none');
  const state = await createFileStateService().read(ctx);
  assert.deepEqual(state.compactionIds, ['cmp-1']);
  const forged = await reloaded.acknowledgeCompaction({ context: ctx, compactionId: 'cmp-9', validationId: 'v-forged', succeeded: true });
  assert.equal(forged.appliedAction, 'escalate');
  const wrongSession = await reloaded.acknowledgeCompaction({ context: context({ projectRoot: root, sessionId: 'other' }), compactionId: 'cmp-2', validationId: decision.validationId, succeeded: true });
  assert.equal(wrongSession.appliedAction, 'escalate');
  // The registry lives in ignored runtime state, never in the durable project files.
  const summary = JSON.parse(await readFile(join(root, '.harness', 'summary.json'), 'utf8'));
  assert.deepEqual(Object.keys(summary).sort(), ['checkpoint', 'checkpointAcks', 'compactionCycles', 'compactionIds']);
  // The acknowledged cycle carries the target-evidence mark (no confirmed/refuted
  // evidence yet), so stagnation identity survives the reload.
  assert.equal(summary.compactionCycles.length, 1);
  assert.equal(summary.compactionCycles[0].id, 'cmp-1');
  assert.match(summary.compactionCycles[0].evidence, /^[0-9a-f]{64}$/);
  assert.deepEqual(state.compactionCycles.map(c => c.id), ['cmp-1']);
});

const fileHarness = (ctx, evidenceWorkflow, state) => createHarness({
  provider: { async decide(request) { return responseFor()(request); } },
  state: state ?? createFileStateService(),
  audit: createFileAuditService(ctx),
  now: () => new Date('2026-01-02T00:00:00.000Z'),
}, { mode: 'enforce', evidenceWorkflow });
const checkpointFor = (overrides = {}) => ({
  goalRef: 'Keep a sample API stable.', rules: ['Keep tests offline'], hypotheses: [],
  attempts: [], keyDecisions: [], inProgress: 'api',
  nextAction: 'ship it', ...overrides,
});

test('real files: a replayed historical ack never republishes its checkpoint after a later cycle', async (t) => {
  for (const evidenceWorkflow of [false, true]) {
    const root = await project(t);
    const ctx = context({ projectRoot: root });
    const h = fileHarness(ctx, evidenceWorkflow);
    const cpA = checkpointFor({ nextAction: 'action A' });
    const cpB = checkpointFor({ nextAction: 'action B' });
    const event = (checkpoint) => ({ context: ctx, summaryText: 'Stable API kept; one observed test passes.', reason: 'threshold', checkpoint });
    const vA = await h.validateCompaction(event(cpA));
    const ackA = await h.acknowledgeCompaction({ context: ctx, compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA });
    assert.equal(ackA.appliedAction, 'allow');
    const vB = await h.validateCompaction(event(cpB));
    const ackB = await h.acknowledgeCompaction({ context: ctx, compactionId: 'cmp-b', validationId: vB.decision.validationId, succeeded: true, checkpoint: cpB });
    assert.equal(ackB.appliedAction, 'allow');
    const before = await createFileStateService().read(ctx);
    assert.equal(before.summary.nextAction, 'action B');
    const replay = await h.acknowledgeCompaction({ context: ctx, compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA });
    assert.equal(replay.appliedAction, 'none');
    const after = await createFileStateService().read(ctx);
    assert.equal(after.summary.nextAction, 'action B');
    assert.equal(after.revision, before.revision); // pure no-op: nothing rewritten
    assert.deepEqual(after.checkpointAcks, [vA.decision.validationId, vB.decision.validationId]);
    assert.deepEqual(after.compactionIds, evidenceWorkflow ? ['cmp-a', 'cmp-b'] : []);
  }
});

test('real files: an interrupted ack followed by an unrelated write rejects the stale checkpoint on retry', async (t) => {
  for (const evidenceWorkflow of [false, true]) {
    const root = await project(t);
    const ctx = context({ projectRoot: root });
    const fileState = createFileStateService();
    let writes = 0;
    const crashing = {
      ...fileState,
      async write(c, revision, mutation) {
        writes += 1;
        // The apply is one atomic compaction-ack mutation; the crash lands on it.
        if (writes === 1 && mutation.kind === 'compaction-ack') throw new Error('crash between registry ack and state apply');
        return fileState.write(c, revision, mutation);
      },
    };
    const h = fileHarness(ctx, evidenceWorkflow, crashing);
    const cpA = checkpointFor({ nextAction: 'action A' });
    const vA = await h.validateCompaction({ context: ctx, summaryText: 'Stable API kept; one observed test passes.', reason: 'threshold', checkpoint: cpA });
    const crashed = await h.acknowledgeCompaction({ context: ctx, compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA });
    assert.equal(crashed.status, 'unavailable');
    // Unrelated state change lands before the retry.
    const ev = await h.recordEvidence({ context: ctx, evidence: { id: 'e1', source: 'tool', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'passed' } });
    assert.equal(ev.appliedAction, 'allow');
    const retry = await h.acknowledgeCompaction({ context: ctx, compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA });
    assert.equal(retry.appliedAction, 'escalate');
    assert.match(retry.reason, /stale/);
    const state = await createFileStateService().read(ctx);
    assert.equal(state.summary, null); // no stale checkpoint overwrite
    assert.deepEqual(state.compactionIds, []);
    assert.deepEqual(state.checkpointAcks, []);
  }
});

test('file registry binds a compactionId to exactly one validationId', async (t) => {
  const root = await project(t);
  const ctx = context({ projectRoot: root });
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const registry = createFileCompactionRegistry(ctx);
  const identity = { projectHash: sha(root), sessionHash: sha(ctx.sessionId), requestHash: sha(ctx.requestId) };
  await registry.save(record({ validationId: 'v-first', ...identity }));
  await registry.save(record({ validationId: 'v-second', ...identity }));
  await registry.acknowledge('v-first', 'cmp-1');
  assert.equal(await registry.lookupCompaction('cmp-1'), 'v-first');
  assert.equal(await registry.lookupCompaction('cmp-9'), null);
  await assert.rejects(() => registry.acknowledge('v-second', 'cmp-1'), /different validation/);
  const reloaded = createFileCompactionRegistry(ctx);
  assert.equal(await reloaded.lookupCompaction('cmp-1'), 'v-first');
  await assert.rejects(() => reloaded.acknowledge('v-second', 'cmp-1'), /different validation/);
});
