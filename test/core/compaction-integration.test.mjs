import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, targetEvidenceMark } from '../../dist/index.js';
import { context, fixtureServices, snapshot } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

const candidate = (overrides = {}) => ({
  context: context(), summaryText: 'Implemented the greeting; one test passes. Next: pick a font.',
  reason: 'threshold', ...overrides,
});
const enforce = (fx, options = {}) => createHarness(fx.services, { mode: 'enforce', ...options });

test('acceptable candidate is audited unchanged, gains a validation id, and ack binds it durably', async () => {
  const fx = fixtureServices({ initial: snapshot({ constraints: [
    { id: 'c-nodeps', createdAt: '2026-01-01', text: 'Do not add dependencies.' },
  ] }), reply: responseFor() });
  const h = enforce(fx);
  const event = candidate({ noteToSelf: 'NOTE: keep the greeting exact.\nNEXT ACTION: pick a font.' });
  const before = structuredClone(event);
  const { decision, retainedPolicyBlock } = await h.validateCompaction(event);
  assert.deepEqual(event, before); // candidate prose/note are never mutated
  assert.equal(decision.status, 'ready');
  assert.equal(decision.appliedAction, 'allow');
  assert.match(decision.validationId, /^v-/);
  assert.match(retainedPolicyBlock, /Goal: Make the sample app greet the user\./);
  assert.match(retainedPolicyBlock, /c-nodeps \(2026-01-01\): Do not add dependencies\./);
  assert.equal(fx.requests.length, 1); // G9 and G10 share one provider call
  assert.deepEqual(Object.keys(fx.requests[0].questions).sort(), [
    'g10-fidelity_contradicts_evidence', 'g10-fidelity_unsupported_facts',
    'g9-drift_drift_score', 'g9-drift_dropped_constraint', 'g9-drift_goal_rewrite',
    'g9-drift_next_action_relation', 'g9-drift_path_back',
  ]);
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(ack.appliedAction, 'allow');
  assert.equal(ack.recordedId, 'cmp-1');
  assert.equal(fx.getState().compactionIds.length, 0); // evidence workflow is opt-in
  assert.match(ack.reason, /evidence workflow is disabled/);
  const folded = fx.compactionValidations.get(decision.validationId);
  assert.equal(folded.compactionId, 'cmp-1');
  assert.equal(folded.record.stateRevision, '1');
  assert.equal(folded.record.mode, 'enforce');
});

test('evidence workflow opt-in advances the counter once per unique successful compaction', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx, { evidenceWorkflow: true });
  const first = await h.validateCompaction(candidate());
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: first.decision.validationId, succeeded: true });
  assert.equal(ack.appliedAction, 'allow');
  assert.deepEqual(fx.getState().compactionIds, ['cmp-1']);
  // Retry of the same acknowledgment is idempotent and never double-counts.
  const retry = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: first.decision.validationId, succeeded: true });
  assert.equal(retry.appliedAction, 'none');
  assert.deepEqual(fx.getState().compactionIds, ['cmp-1']);
});

test('identical prose in two distinct cycles counts twice; replayed success counts once', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx, { evidenceWorkflow: true });
  const prose = candidate();
  const cycle1 = await h.validateCompaction(prose);
  const cycle2 = await h.validateCompaction(prose); // same bytes, new cycle
  assert.notEqual(cycle1.decision.validationId, cycle2.decision.validationId);
  await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-a', validationId: cycle1.decision.validationId, succeeded: true });
  // cycle2's validation is now stale relative to the counter write.
  const stale = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-b', validationId: cycle2.decision.validationId, succeeded: true });
  assert.equal(stale.appliedAction, 'escalate');
  assert.match(stale.reason, /stale/);
  const cycle3 = await h.validateCompaction(prose);
  await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-b', validationId: cycle3.decision.validationId, succeeded: true });
  assert.deepEqual(fx.getState().compactionIds, ['cmp-a', 'cmp-b']);
  const replay = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-b', validationId: cycle3.decision.validationId, succeeded: true });
  assert.equal(replay.appliedAction, 'none');
  assert.deepEqual(fx.getState().compactionIds, ['cmp-a', 'cmp-b']);
});

test('forged, mismatched, consumed, and stale acknowledgments are rejected', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx, { evidenceWorkflow: true });
  const forged = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-x', validationId: 'v-neverissued', succeeded: true });
  assert.equal(forged.appliedAction, 'escalate');
  assert.match(forged.reason, /Unknown compaction validation id/);
  const { decision } = await h.validateCompaction(candidate());
  const wrongSession = await h.acknowledgeCompaction({ context: context({ sessionId: 'session-2' }), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(wrongSession.appliedAction, 'escalate');
  assert.match(wrongSession.reason, /different project, session, request, or mode/);
  const wrongRequest = await h.acknowledgeCompaction({ context: context({ requestId: 'request-2' }), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(wrongRequest.appliedAction, 'escalate');
  // Any state mutation after validation makes the validation stale.
  await h.recordEvidence({ context: context(), evidence: { id: 'e1', source: 'tool', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'passed' } });
  const stale = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(stale.appliedAction, 'escalate');
  assert.match(stale.reason, /stale/);
  const fresh = await h.validateCompaction(candidate());
  await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: fresh.decision.validationId, succeeded: true });
  const consumed = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-2', validationId: fresh.decision.validationId, succeeded: true });
  assert.equal(consumed.appliedAction, 'escalate');
  assert.match(consumed.reason, /consumed by a different compaction/);
  assert.deepEqual(fx.getState().compactionIds, ['cmp-1']);
});

test('shadow mode observes but changes no registry or project state', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = createHarness(fx.services); // shadow default
  const { decision, retainedPolicyBlock } = await h.validateCompaction(candidate());
  assert.equal(decision.status, 'ready');
  assert.equal(decision.appliedAction, 'allow');
  assert.equal(decision.validationId, undefined);
  assert.ok(retainedPolicyBlock.length > 0);
  assert.equal(fx.compactionValidations.size, 0);
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: 'v-anything', succeeded: true });
  assert.equal(ack.appliedAction, 'none');
  assert.equal(fx.compactionValidations.size, 0);
  assert.deepEqual(fx.getState().compactionIds, []);
});

test('policy holds are explicit and never issue a validation id; transport failure is retryable', async () => {
  const held = fixtureServices({ reply: responseFor({ score: { 'g9-drift_drift_score': 3 } }) });
  const hold = await enforce(held).validateCompaction(candidate());
  assert.equal(hold.decision.status, 'ready');
  assert.equal(hold.decision.proposedAction, 'replan');
  assert.equal(hold.decision.validationId, undefined);
  assert.equal(held.compactionValidations.size, 0);
  const blocked = fixtureServices({ reply: responseFor({ noul: { 'g10-fidelity_contradicts_evidence': 0.9 } }) });
  const denial = await enforce(blocked).validateCompaction(candidate());
  assert.equal(denial.decision.proposedAction, 'block');
  assert.equal(denial.decision.validationId, undefined);
  const offline = fixtureServices({ reply: new Error('offline') });
  const unavailable = await enforce(offline).validateCompaction(candidate());
  assert.equal(unavailable.decision.status, 'unavailable');
  assert.equal(unavailable.decision.appliedAction, 'escalate');
  assert.equal(unavailable.decision.validationId, undefined);
  const auditDown = fixtureServices({ reply: responseFor(), auditFails: true });
  const notAudited = await enforce(auditDown).validateCompaction(candidate());
  assert.equal(notAudited.decision.status, 'unavailable');
  assert.equal(notAudited.decision.validationId, undefined);
  assert.equal(auditDown.compactionValidations.size, 0);
});

test('missing prose, secrets, and invalid checkpoints are rejected before any provider call', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx);
  const empty = await h.validateCompaction(candidate({ summaryText: '  ', noteToSelf: undefined }));
  assert.equal(empty.decision.appliedAction, 'escalate');
  const token = 'sk-' + 'or-v1-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const secret = await h.validateCompaction(candidate({ summaryText: `token ${token} inside` }));
  assert.equal(secret.decision.appliedAction, 'escalate');
  assert.equal(JSON.stringify(fx.auditEntries).includes(token), false);
  const badCheckpoint = await h.validateCompaction(candidate({ checkpoint: { goalRef: '' } }));
  assert.equal(badCheckpoint.decision.appliedAction, 'escalate');
  assert.equal(fx.requests.length, 0);
  assert.equal(fx.compactionValidations.size, 0);
});

test('no typed checkpoint is fabricated from prose and untrusted projects stay inert', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx, { evidenceWorkflow: true });
  const { decision } = await h.validateCompaction(candidate());
  await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(fx.getState().summary, null); // prose never becomes typed facts
  const untrusted = fixtureServices({ reply: responseFor() });
  const inert = await enforce(untrusted).validateCompaction(candidate({ context: context({ trusted: false }) }));
  assert.equal(inert.decision.status, 'inert');
  assert.equal(inert.retainedPolicyBlock, '');
  assert.equal(untrusted.requests.length, 0);
});

const checkpointFor = (overrides = {}) => ({
  goalRef: 'Make the sample app greet the user.', rules: ['Keep tests offline'], hypotheses: [],
  attempts: [], keyDecisions: ['Pick the system font stack'], inProgress: 'greeting',
  nextAction: 'pick a font', ...overrides,
});

test('G9 and G10 judge the actual typed checkpoint, bound to the record by hash', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx);
  const checkpoint = checkpointFor();
  const { decision } = await h.validateCompaction(candidate({ checkpoint }));
  assert.match(decision.validationId, /^v-/);
  const g9 = fx.requests[0].state['g9-drift'];
  assert.equal(g9.candidate.checkpoint.goalRef, 'Make the sample app greet the user.');
  assert.equal(g9.candidate.checkpoint.nextAction, 'pick a font');
  const g10 = fx.requests[0].state['g10-fidelity'];
  assert.equal(g10.candidate.checkpoint.keyDecisions[0], 'Pick the system font stack');
  assert.match(fx.compactionValidations.get(decision.validationId).record.checkpointHash, /^[0-9a-f]{64}$/);
});

test('validated checkpoint persists only on a bound successful ack, preserving prior decisions', async () => {
  const prior = checkpointFor({ keyDecisions: ['Use the local fixture server, never the live API.'], rules: [] });
  const fx = fixtureServices({ initial: snapshot({ summary: prior }), reply: responseFor() });
  const h = enforce(fx);
  const checkpoint = checkpointFor();
  const { decision } = await h.validateCompaction(candidate({ checkpoint }));
  // Not persisted at validation time.
  assert.equal(fx.getState().summary.keyDecisions[0], 'Use the local fixture server, never the live API.');
  const ack = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true, checkpoint,
  });
  assert.equal(ack.appliedAction, 'allow');
  const summary = fx.getState().summary;
  assert.deepEqual(summary.keyDecisions, ['Pick the system font stack', 'Use the local fixture server, never the live API.']);
  assert.deepEqual(summary.rules, ['Keep tests offline']);
  // A replayed ack does not rewrite or duplicate the persisted checkpoint.
  const replay = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true, checkpoint,
  });
  assert.equal(replay.appliedAction, 'none');
  assert.deepEqual(fx.getState().summary.keyDecisions, summary.keyDecisions);
});

test('ack rejects an unbound or foreign checkpoint and a mismatched candidate hash', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx);
  const { decision } = await h.validateCompaction(candidate({ checkpoint: checkpointFor() }));
  const foreign = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true,
    checkpoint: checkpointFor({ nextAction: 'delete the tests' }),
  });
  assert.equal(foreign.appliedAction, 'escalate');
  assert.match(foreign.reason, /not part of the validated candidate/);
  const { compactionCandidateHash } = await import('../../dist/index.js');
  const wrongHash = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true,
    candidateHash: '0'.repeat(64),
  });
  assert.equal(wrongHash.appliedAction, 'escalate');
  assert.match(wrongHash.reason, /does not match the validated candidate/);
  const bound = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true,
    candidateHash: compactionCandidateHash(candidate({ checkpoint: checkpointFor() })),
  });
  assert.equal(bound.appliedAction, 'allow');
  // A checkpoint that was never validated cannot ride along on a valid ack.
  const plain = await h.validateCompaction(candidate());
  const smuggled = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-2', validationId: plain.decision.validationId, succeeded: true,
    checkpoint: checkpointFor(),
  });
  assert.equal(smuggled.appliedAction, 'escalate');
  assert.match(smuggled.reason, /not part of the validated candidate/);
});

test('a forged validation id on an existing compaction escalates instead of succeeding early', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx, { evidenceWorkflow: true });
  const { decision } = await h.validateCompaction(candidate());
  await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.deepEqual(fx.getState().compactionIds, ['cmp-1']);
  const forged = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: 'v-forged', succeeded: true });
  assert.equal(forged.appliedAction, 'escalate');
  assert.match(forged.reason, /Unknown compaction validation id/);
  assert.deepEqual(fx.getState().compactionIds, ['cmp-1']);
});

test('two validation ids can never acknowledge the same compaction, with or without counters', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = enforce(fx); // evidence workflow off: state.compactionIds stays empty
  const first = await h.validateCompaction(candidate());
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: first.decision.validationId, succeeded: true });
  assert.equal(ack.appliedAction, 'allow');
  const second = await h.validateCompaction(candidate()); // state untouched: same revision
  const reuse = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: second.decision.validationId, succeeded: true });
  assert.equal(reuse.appliedAction, 'escalate');
  assert.match(reuse.reason, /already acknowledged under a different validation/);
  const bound = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-2', validationId: second.decision.validationId, succeeded: true });
  assert.equal(bound.appliedAction, 'allow');
});

test('a failed audit publishes no registry binding and no state mutation', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  let auditDown = false;
  const services = {
    ...fx.services,
    audit: { async append(entry) { if (auditDown) throw new Error('audit down'); return fx.services.audit.append(entry); } },
  };
  const h = createHarness(services, { mode: 'enforce', evidenceWorkflow: true });
  const { decision } = await h.validateCompaction(candidate());
  assert.match(decision.validationId, /^v-/);
  auditDown = true;
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(ack.status, 'unavailable');
  assert.equal(fx.compactionValidations.get(decision.validationId).compactionId, undefined);
  assert.deepEqual(fx.getState().compactionIds, []);
  // Retry after recovery completes the binding and the counter exactly once.
  auditDown = false;
  const retry = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(retry.appliedAction, 'allow');
  assert.equal(fx.compactionValidations.get(decision.validationId).compactionId, 'cmp-1');
  assert.deepEqual(fx.getState().compactionIds, ['cmp-1']);
});

test('cancellation before durable recording writes no registry or counter state', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const controller = new AbortController();
  const h = createHarness(fx.services, { mode: 'enforce', evidenceWorkflow: true, signal: controller.signal });
  const { decision } = await h.validateCompaction(candidate());
  assert.match(decision.validationId, /^v-/);
  controller.abort();
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'cmp-1', validationId: decision.validationId, succeeded: true });
  assert.equal(ack.status, 'unavailable');
  assert.match(ack.reason, /cancelled/);
  assert.equal(fx.compactionValidations.get(decision.validationId).compactionId, undefined);
  assert.deepEqual(fx.getState().compactionIds, []);
  const cancelled = await h.validateCompaction(candidate());
  assert.equal(cancelled.decision.status, 'unavailable');
  assert.equal(fx.requests.length, 1); // no provider call after cancellation
});

test('a replayed historical ack never republishes its checkpoint after a later cycle', async () => {
  for (const evidenceWorkflow of [false, true]) {
    const fx = fixtureServices({ reply: responseFor() });
    const h = createHarness(fx.services, { mode: 'enforce', evidenceWorkflow });
    const cpA = checkpointFor({ nextAction: 'action A' });
    const cpB = checkpointFor({ nextAction: 'action B' });
    const vA = await h.validateCompaction(candidate({ checkpoint: cpA }));
    const ackA = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA,
    });
    assert.equal(ackA.appliedAction, 'allow');
    assert.equal(fx.getState().summary.nextAction, 'action A');
    const vB = await h.validateCompaction(candidate({ checkpoint: cpB }));
    const ackB = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-b', validationId: vB.decision.validationId, succeeded: true, checkpoint: cpB,
    });
    assert.equal(ackB.appliedAction, 'allow');
    assert.equal(fx.getState().summary.nextAction, 'action B');
    const revisionBefore = fx.getState().revision;
    // Replaying the original ack is idempotent and writes nothing.
    const replay = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA,
    });
    assert.equal(replay.appliedAction, 'none');
    assert.equal(fx.getState().summary.nextAction, 'action B');
    assert.equal(fx.getState().revision, revisionBefore);
    assert.deepEqual(fx.getState().checkpointAcks, [vA.decision.validationId, vB.decision.validationId]);
  }
});

test('an interrupted checkpoint apply is recovered exactly once by the retry', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  let writes = 0;
  const services = {
    ...fx.services,
    state: {
      ...fx.services.state,
      async write(ctx, revision, mutation) {
        writes += 1;
        // The checkpoint apply is one atomic compaction-ack mutation (counter +
        // merged checkpoint + application marker), so the crash lands on it.
        if (writes === 1 && mutation.kind === 'compaction-ack') throw new Error('crash between registry ack and state apply');
        return fx.services.state.write(ctx, revision, mutation);
      },
    },
  };
  const h = createHarness(services, { mode: 'enforce' });
  const cpA = checkpointFor({ nextAction: 'action A' });
  const v = await h.validateCompaction(candidate({ checkpoint: cpA }));
  const crashed = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-a', validationId: v.decision.validationId, succeeded: true, checkpoint: cpA,
  });
  assert.equal(crashed.status, 'unavailable');
  assert.equal(fx.getState().summary, null); // nothing published yet
  const retry = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-a', validationId: v.decision.validationId, succeeded: true, checkpoint: cpA,
  });
  assert.equal(retry.appliedAction, 'none'); // registry binding already existed
  assert.equal(fx.getState().summary.nextAction, 'action A'); // recovered once
  const again = await h.acknowledgeCompaction({
    context: context(), compactionId: 'cmp-a', validationId: v.decision.validationId, succeeded: true, checkpoint: cpA,
  });
  assert.equal(again.appliedAction, 'none');
  assert.equal(fx.getState().summary.nextAction, 'action A');
  assert.equal(writes, 2); // crashed attempt + one recovery write; marker blocks more
});

test('counter and checkpoint apply atomically in a single state write', async () => {
  for (const evidenceWorkflow of [false, true]) {
    const fx = fixtureServices({ reply: responseFor() });
    let writes = 0;
    const services = {
      ...fx.services,
      state: {
        ...fx.services.state,
        async write(ctx, revision, mutation) {
          writes += 1;
          return fx.services.state.write(ctx, revision, mutation);
        },
      },
    };
    const h = createHarness(services, { mode: 'enforce', evidenceWorkflow });
    const cp = checkpointFor({ nextAction: 'atomic action' });
    const v = await h.validateCompaction(candidate({ checkpoint: cp }));
    const ack = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-1', validationId: v.decision.validationId, succeeded: true, checkpoint: cp,
    });
    assert.equal(ack.appliedAction, 'allow');
    assert.equal(writes, 1); // counter + merged checkpoint + marker in one mutation
    assert.equal(fx.getState().summary.nextAction, 'atomic action');
    assert.deepEqual(fx.getState().checkpointAcks, [v.decision.validationId]);
    assert.deepEqual(fx.getState().compactionIds, evidenceWorkflow ? ['cmp-1'] : []);
  }
});

test('an interrupted ack followed by an unrelated state change fails closed; no stale checkpoint overwrite', async () => {
  for (const evidenceWorkflow of [false, true]) {
    const fx = fixtureServices({ reply: responseFor() });
    let writes = 0;
    const services = {
      ...fx.services,
      state: {
        ...fx.services.state,
        async write(ctx, revision, mutation) {
          writes += 1;
          if (writes === 1 && mutation.kind === 'compaction-ack') throw new Error('crash between registry ack and state apply');
          return fx.services.state.write(ctx, revision, mutation);
        },
      },
    };
    const h = createHarness(services, { mode: 'enforce', evidenceWorkflow });
    const cpA = checkpointFor({ nextAction: 'action A' });
    const cpB = checkpointFor({ nextAction: 'action B' });
    const vA = await h.validateCompaction(candidate({ checkpoint: cpA }));
    const crashed = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA,
    });
    assert.equal(crashed.status, 'unavailable'); // registry bound, state untouched
    assert.equal(fx.getState().summary, null);
    // An unrelated state write lands before the retry.
    const ev = await h.recordEvidence({ context: context(), evidence: { id: 'e1', source: 'tool', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'passed' } });
    assert.equal(ev.appliedAction, 'allow');
    // The retry must not merge the stale validated checkpoint into newer state.
    const retry = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA,
    });
    assert.equal(retry.appliedAction, 'escalate');
    assert.match(retry.reason, /stale/);
    assert.equal(fx.getState().summary, null);
    assert.deepEqual(fx.getState().compactionIds, []);
    // A fresh cycle validates and applies cleanly at the new revision.
    const vB = await h.validateCompaction(candidate({ checkpoint: cpB }));
    const ackB = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-b', validationId: vB.decision.validationId, succeeded: true, checkpoint: cpB,
    });
    assert.equal(ackB.appliedAction, 'allow');
    assert.equal(fx.getState().summary.nextAction, 'action B');
    // The interrupted validation stays rejected: replaying it never overwrites B.
    const again = await h.acknowledgeCompaction({
      context: context(), compactionId: 'cmp-a', validationId: vA.decision.validationId, succeeded: true, checkpoint: cpA,
    });
    assert.equal(again.appliedAction, 'escalate');
    assert.equal(fx.getState().summary.nextAction, 'action B');
    assert.deepEqual(fx.getState().compactionIds, evidenceWorkflow ? ['cmp-b'] : []);
  }
});

test('stagnation replan audits before the registry save; a failed audit leaves no record', async () => {
  const mark = targetEvidenceMark(snapshot());
  const fx = fixtureServices({ initial: snapshot({
    compactionIds: ['c1', 'c2'], compactionCycles: [{ id: 'c1', evidence: mark }, { id: 'c2', evidence: mark }],
  }), reply: responseFor() });
  let auditDown = false;
  const services = {
    ...fx.services,
    audit: { async append(entry) { if (auditDown) throw new Error('audit down'); return fx.services.audit.append(entry); } },
  };
  const h = createHarness(services, { mode: 'enforce', evidenceWorkflow: true });
  auditDown = true;
  const held = await h.validateCompaction(candidate());
  assert.equal(held.decision.status, 'unavailable'); // audit of the replan failed
  assert.equal(held.decision.validationId, undefined);
  assert.equal(fx.compactionValidations.size, 0); // no registry record published
  auditDown = false;
  const retry = await h.validateCompaction(candidate());
  assert.equal(retry.decision.proposedAction, 'replan');
  assert.match(retry.decision.validationId, /^v-/);
  assert.equal(fx.compactionValidations.size, 1);
});
