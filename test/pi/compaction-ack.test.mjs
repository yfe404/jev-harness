// Compaction acknowledgment identity tests: the adapter must acknowledge the
// actual latest persisted compaction entry, never blindly the event's entry,
// recompute the candidate hash from the actual persisted summary (never echo
// metadata), require the origin request identity, and surface held/failed
// acknowledgments to the bridge.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, compactionCandidateHash } from '../../dist/index.js';
import { createPiHarnessExtension } from '../../dist/adapters/pi/index.js';
import { fixtureServices, snapshot } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

const ORIGIN = { host: 'pi', projectRoot: '/example', sessionId: 'sess-1', requestId: 'req-origin', trusted: true };
const CHECKPOINT = {
  goalRef: 'Make the sample app greet the user.', rules: [], hypotheses: [],
  attempts: [], keyDecisions: ['Use the local fixture server'], inProgress: 'greeting', nextAction: 'ship it',
};

function host({ branch = [], harness: injected } = {}) {
  const fx = fixtureServices({ initialized: true, reply: responseFor(), initial: snapshot() });
  const harness = injected ?? createHarness(fx.services, { mode: 'enforce' });
  const acks = [];
  const spy = { ...harness, acknowledgeCompaction: async event => { acks.push(event); return harness.acknowledgeCompaction(event); } };
  const handlers = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: () => {},
    registerCommand: () => {},
  };
  const bridge = {};
  const ackDecisions = [];
  bridge.onCompactionAck = decision => ackDecisions.push(decision);
  const notifications = [];
  createPiHarnessExtension({ harness: spy, mode: 'enforce', runtime: fx.services.runtime, readState: async () => fx.getState(), bridge })(pi);
  const state = { branch };
  const ctx = {
    cwd: '/example', mode: 'json', hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => 'sess-1', getBranch: () => state.branch },
    ui: { notify: (message, type) => notifications.push({ message, type }), setStatus: () => {} },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  return { fx, harness, emit, acks, ackDecisions, notifications, setBranch: next => { state.branch = next; } };
}

const compactionEntry = (id, summary, meta) => ({
  type: 'compaction', id, summary,
  details: meta ? { jevHarness: meta } : {},
});

/** A real validation: returns the metadata the wrapper persists under
 * details.jevHarness (validationId, origin requestId, candidateHash over the
 * exact summary/note/checkpoint, and the preserved note/checkpoint bytes). */
async function validatedMeta(harness, { summary = 'compact summary', noteToSelf, checkpoint } = {}) {
  const event = {
    context: ORIGIN, summaryText: summary, reason: 'manual',
    ...(noteToSelf !== undefined ? { noteToSelf } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
  };
  const { decision } = await harness.validateCompaction(event);
  assert.equal(decision.status, 'ready');
  assert.ok(decision.validationId, 'enforce validation issues a validation id');
  return {
    validationId: decision.validationId, requestId: ORIGIN.requestId,
    candidateHash: compactionCandidateHash(event),
    ...(noteToSelf !== undefined ? { noteToSelf } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
  };
}

test('identical summaries: acknowledgment uses the latest persisted entry, not the aliased event id', async () => {
  // Pi 0.85.1 finds the compaction entry by summary text; two identical
  // summaries can alias the older entry in the event. The branch holds the truth.
  const older = compactionEntry('cmp-older', 'same summary', { validationId: 'val-1', requestId: 'req-origin' });
  const latest = compactionEntry('cmp-latest', 'same summary', { validationId: 'val-2', requestId: 'req-origin' });
  const h = host({ branch: [older, { type: 'message' }, latest] });
  await h.emit('session_start', { reason: 'startup' });
  // The event carries the aliased older entry; the adapter must ignore its id.
  await h.emit('session_compact', { compactionEntry: older, fromExtension: true, reason: 'manual' });
  assert.equal(h.acks.length, 1);
  assert.equal(h.acks[0].compactionId, 'cmp-latest');
  assert.equal(h.acks[0].validationId, 'val-2');
  assert.equal(h.acks[0].succeeded, true);
  // The candidate hash is recomputed from the actual persisted summary, never
  // echoed from metadata (none was persisted here).
  assert.equal(h.acks[0].candidateHash, compactionCandidateHash({ summaryText: 'same summary' }));
  assert.equal(h.acks[0].context.requestId, 'req-origin', 'bound to the origin request, never the current one');

  // Replaying the same success notification re-acknowledges the same persisted
  // identity, which the core dedupes (no second successful cycle can emerge).
  await h.emit('session_compact', { compactionEntry: latest, fromExtension: true, reason: 'manual' });
  assert.equal(h.acks.length, 2);
  assert.equal(h.acks[1].compactionId, 'cmp-latest');
  assert.equal(h.acks[1].validationId, 'val-2');
});

test('unvalidated native compactions are never acknowledged', async () => {
  const native = compactionEntry('cmp-native', 'native summary', undefined);
  const h = host({ branch: [native] });
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_compact', { compactionEntry: native, fromExtension: false, reason: 'overflow' });
  assert.equal(h.acks.length, 0, 'no validation id means honestly absent coverage, never an inferred ack');
});

test('no persisted compaction entry on the branch means no acknowledgment', async () => {
  const h = host({ branch: [{ type: 'message' }] });
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_compact', { compactionEntry: compactionEntry('cmp-x', 's', { validationId: 'val-x', requestId: 'req-origin' }) });
  assert.equal(h.acks.length, 0);
});

test('validated metadata without the origin request identity is never acknowledged', async () => {
  // Old or forged metadata: no fallback to whatever request is active now.
  const forged = compactionEntry('cmp-1', 'summary', { validationId: 'val-1' });
  const h = host({ branch: [forged] });
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_compact', { compactionEntry: forged, fromExtension: true, reason: 'manual' });
  assert.equal(h.acks.length, 0, 'no origin request identity, no acknowledgment');
  assert.equal(h.ackDecisions.length, 1, 'the bridge is told so the wrapper pauses continuation');
  assert.notEqual(h.ackDecisions[0].status, 'ready');
  assert.match(h.ackDecisions[0].reason, /origin request identity/);
  assert.ok(h.notifications.some(n => /origin request identity/.test(n.message)));
});

test('a validated compaction acknowledges with the recomputed hash and the exact checkpoint', async () => {
  const summary = 'Greeting implemented; next: ship it';
  const noteToSelf = 'NEXT ACTION: ship it';
  const h = host();
  const meta = await validatedMeta(h.harness, { summary, noteToSelf, checkpoint: CHECKPOINT });
  const entry = compactionEntry('cmp-1', summary, meta);
  h.setBranch([entry]);
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_compact', { compactionEntry: entry, fromExtension: true, reason: 'manual' });
  assert.equal(h.acks.length, 1);
  assert.equal(h.acks[0].candidateHash, meta.candidateHash, 'recomputed hash equals the recorded one');
  assert.deepEqual(h.acks[0].checkpoint, CHECKPOINT, 'the exact validated checkpoint is passed through');
  assert.equal(h.acks[0].context.requestId, 'req-origin');
  assert.equal(h.ackDecisions.length, 1);
  assert.equal(h.ackDecisions[0].status, 'ready', 'a genuine validated success acknowledges');
  assert.ok(h.fx.getState().summary?.keyDecisions.includes('Use the local fixture server'),
    'the validated checkpoint is applied to durable state');
});

test('a summary modified after validation reusing its metadata is not acknowledged', async () => {
  const h = host();
  const meta = await validatedMeta(h.harness, { summary: 'honest summary', noteToSelf: 'NEXT ACTION: x' });
  const tampered = compactionEntry('cmp-1', 'tampered summary: claim victory', meta);
  h.setBranch([tampered]);
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_compact', { compactionEntry: tampered, fromExtension: true, reason: 'manual' });
  assert.equal(h.acks.length, 0, 'recomputed hash differs from the persisted candidateHash');
  assert.equal(h.ackDecisions.length, 1);
  assert.notEqual(h.ackDecisions[0].status, 'ready');
  assert.match(h.ackDecisions[0].reason, /does not match the validated candidate/);
});

test('a stale validation (state changed after validation) is a surfaced hold, never swallowed', async () => {
  const h = host();
  const meta = await validatedMeta(h.harness, { summary: 'cycle summary' });
  // State advances after the candidate was validated: the ack must escalate.
  const recorded = await h.harness.recordEvidence({ context: ORIGIN, evidence: {
    id: 'ev-stale-1', source: 'tool', observedAt: '2026-01-02T00:00:00.000Z', method: 'bash', observation: 'npm test ok',
  } });
  assert.ok(recorded.recordedId, 'state actually advanced after validation');
  const entry = compactionEntry('cmp-1', 'cycle summary', meta);
  h.setBranch([entry]);
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_compact', { compactionEntry: entry, fromExtension: true, reason: 'manual' });
  assert.equal(h.acks.length, 1, 'the ack is attempted against the durable registry');
  assert.equal(h.ackDecisions.length, 1);
  assert.notEqual(h.ackDecisions[0].status, 'ready', 'stale validation does not acknowledge');
  assert.match(h.ackDecisions[0].reason, /stale/i);
  assert.ok(h.notifications.some(n => /held/i.test(n.message)), 'the hold reaches the operator');
});

test('a thrown acknowledgment notifies the bridge so the wrapper pauses continuation', async () => {
  const fx = fixtureServices({ initialized: true, reply: responseFor(), initial: snapshot() });
  const failing = {
    ...createHarness(fx.services, { mode: 'enforce' }),
    acknowledgeCompaction: async () => { throw new Error('registry disk gone'); },
  };
  const entry = compactionEntry('cmp-1', 'summary', { validationId: 'val-1', requestId: 'req-origin' });
  const h = host({ branch: [entry], harness: failing });
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_compact', { compactionEntry: entry, fromExtension: true, reason: 'manual' });
  assert.equal(h.ackDecisions.length, 1, 'failure is surfaced, not swallowed');
  assert.equal(h.ackDecisions[0].status, 'unavailable');
  assert.match(h.ackDecisions[0].reason, /registry disk gone/);
  assert.ok(h.notifications.some(n => /acknowledgment failed/.test(n.message)));
});
