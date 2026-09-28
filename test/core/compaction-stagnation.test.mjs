import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, stagnantCycles, targetEvidenceMark } from '../../dist/index.js';
import { context, fixtureServices, snapshot } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

const candidate = (overrides = {}) => ({
  context: context(), summaryText: 'Implemented the greeting; one test passes. Next: pick a font.',
  reason: 'threshold', ...overrides,
});
const enforce = (fx, options = {}) => createHarness(fx.services, { mode: 'enforce', ...options });
const cyclesFor = (ids, mark) => ids.map(id => ({ id, evidence: mark }));
const confirmed = (id) => ({ id, source: 'harness', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'greeting test passed', result: 'confirmed' });

test('two stagnant cycles replan with an ack-able validation; three halt with none', async () => {
  const mark = targetEvidenceMark(snapshot());
  const fx = fixtureServices({ initial: snapshot({
    compactionIds: ['c1', 'c2'], compactionCycles: cyclesFor(['c1', 'c2'], mark),
  }), reply: responseFor() });
  const h = enforce(fx, { evidenceWorkflow: true });
  const held = await h.validateCompaction(candidate());
  assert.equal(held.decision.gateId, 'evidence-stagnation');
  assert.equal(held.decision.proposedAction, 'replan');
  assert.equal(held.decision.appliedAction, 'replan');
  assert.equal(held.decision.stagnantCycles, 2);
  // The hold does not prevent counting: a host-confirmed success still acknowledges.
  assert.match(held.decision.validationId, /^v-/);
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'c3', validationId: held.decision.validationId, succeeded: true });
  assert.equal(ack.appliedAction, 'allow');
  assert.deepEqual(fx.getState().compactionIds, ['c1', 'c2', 'c3']);
  const halted = await h.validateCompaction(candidate());
  assert.equal(halted.decision.gateId, 'evidence-stagnation');
  assert.equal(halted.decision.proposedAction, 'halt');
  assert.equal(halted.decision.appliedAction, 'halt');
  assert.equal(halted.decision.stagnantCycles, 3);
  assert.equal(halted.decision.validationId, undefined);
  assert.equal(fx.compactionValidations.size, 1); // the halt recorded nothing new
});

test('new confirmed or refuted target evidence resets stagnation exactly once', async () => {
  const staleMark = targetEvidenceMark(snapshot());
  const fx = fixtureServices({ initial: snapshot({
    evidence: [confirmed('e1')],
    compactionIds: ['c1', 'c2'], compactionCycles: cyclesFor(['c1', 'c2'], staleMark),
  }), reply: responseFor() });
  assert.equal(stagnantCycles(fx.getState()), 0);
  const h = enforce(fx, { evidenceWorkflow: true });
  const { decision } = await h.validateCompaction(candidate());
  assert.equal(decision.appliedAction, 'allow');
  assert.equal(decision.stagnantCycles, 0);
  assert.match(decision.validationId, /^v-/);
  // One new cycle starts the trailing count again.
  await h.acknowledgeCompaction({ context: context(), compactionId: 'c3', validationId: decision.validationId, succeeded: true });
  assert.equal(stagnantCycles(fx.getState()), 1);
});

test('inconclusive observations, setup failures, and retries never reset or advance stagnation', async () => {
  const mark = targetEvidenceMark(snapshot());
  const fx = fixtureServices({ initial: snapshot({
    evidence: [
      { id: 'e-tool', source: 'tool', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'still running' },
      { id: 'e-setup', source: 'harness', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'missing fixture', result: 'setup_failure' },
      { id: 'e-maybe', source: 'harness', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'flaky', result: 'inconclusive' },
    ],
    compactionIds: ['c1', 'c2'], compactionCycles: cyclesFor(['c1', 'c2'], mark),
  }), reply: responseFor() });
  assert.equal(stagnantCycles(fx.getState()), 2);
  const h = enforce(fx, { evidenceWorkflow: true });
  const held = await h.validateCompaction(candidate());
  assert.equal(held.decision.proposedAction, 'replan');
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'c3', validationId: held.decision.validationId, succeeded: true });
  assert.equal(ack.appliedAction, 'allow');
  // A replayed acknowledgment neither advances nor resets the count.
  const replay = await h.acknowledgeCompaction({ context: context(), compactionId: 'c3', validationId: held.decision.validationId, succeeded: true });
  assert.equal(replay.appliedAction, 'none');
  assert.equal(stagnantCycles(fx.getState()), 3);
  assert.deepEqual(fx.getState().compactionIds, ['c1', 'c2', 'c3']);
});

test('evidenceWorkflow off leaves ordinary projects unaffected by stagnation state', async () => {
  const mark = targetEvidenceMark(snapshot());
  const fx = fixtureServices({ initial: snapshot({
    compactionIds: ['c1', 'c2', 'c3'], compactionCycles: cyclesFor(['c1', 'c2', 'c3'], mark),
  }), reply: responseFor() });
  const h = enforce(fx); // workflow off
  const { decision } = await h.validateCompaction(candidate());
  assert.equal(decision.appliedAction, 'allow');
  assert.equal(decision.stagnantCycles, undefined);
  assert.match(decision.validationId, /^v-/);
  const ack = await h.acknowledgeCompaction({ context: context(), compactionId: 'c4', validationId: decision.validationId, succeeded: true });
  assert.equal(ack.appliedAction, 'allow');
  assert.deepEqual(fx.getState().compactionIds, ['c1', 'c2', 'c3']); // counter never moves
});

test('shadow observes stagnation without registry or state writes', async () => {
  const mark = targetEvidenceMark(snapshot());
  const fx = fixtureServices({ initial: snapshot({
    compactionIds: ['c1', 'c2', 'c3'], compactionCycles: cyclesFor(['c1', 'c2', 'c3'], mark),
  }), reply: responseFor() });
  const h = createHarness(fx.services, { evidenceWorkflow: true }); // shadow
  const { decision } = await h.validateCompaction(candidate());
  assert.equal(decision.gateId, 'evidence-stagnation');
  assert.equal(decision.proposedAction, 'halt');
  assert.equal(decision.appliedAction, 'allow'); // observational only
  assert.equal(decision.validationId, undefined);
  assert.equal(fx.compactionValidations.size, 0);
  assert.deepEqual(fx.getState().compactionIds, ['c1', 'c2', 'c3']);
});

test('cycles recorded before evidence-mark tracking never count as stagnant', async () => {
  const fx = fixtureServices({ initial: snapshot({
    compactionIds: ['c1', 'c2', 'c3'], compactionCycles: cyclesFor(['c1', 'c2', 'c3'], null),
  }), reply: responseFor() });
  assert.equal(stagnantCycles(fx.getState()), 0);
  const h = enforce(fx, { evidenceWorkflow: true });
  const { decision } = await h.validateCompaction(candidate());
  assert.equal(decision.appliedAction, 'allow');
  assert.equal(decision.stagnantCycles, 0);
});
