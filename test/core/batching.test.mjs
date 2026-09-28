import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../../dist/index.js';
import { context, fixtureServices, snapshot } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

const candidate = (overrides = {}) => ({
  context: context(), summaryText: 'Implemented the greeting; one test passes. Next: pick a font.',
  reason: 'threshold', ...overrides,
});

test('shadow returns the strongest proposed verdict, not the first gate allow', async () => {
  // G9 allows; G10 proposes block. Shadow must surface the block, observational only.
  const fx = fixtureServices({ reply: responseFor({ noul: { 'g10-fidelity_contradicts_evidence': 0.9 } }) });
  const h = createHarness(fx.services); // shadow
  const { decision } = await h.validateCompaction(candidate());
  assert.equal(decision.gateId, 'g10-fidelity');
  assert.equal(decision.proposedAction, 'block');
  assert.equal(decision.appliedAction, 'allow');
  assert.equal(decision.validationId, undefined);
  const enforceFx = fixtureServices({ reply: responseFor({ noul: { 'g10-fidelity_contradicts_evidence': 0.9 } }) });
  const enforced = await createHarness(enforceFx.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(enforced.decision.gateId, 'g10-fidelity');
  assert.equal(enforced.decision.appliedAction, 'block');
});

test('a candidate too large to judge whole fails unavailable instead of being truncated', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const h = createHarness(fx.services, { mode: 'enforce' });
  const huge = candidate({ summaryText: `start ${'x'.repeat(60_000)} end` });
  const { decision } = await h.validateCompaction(huge);
  assert.equal(decision.status, 'unavailable');
  assert.equal(decision.appliedAction, 'escalate');
  assert.match(decision.reason, /exceeds the provider request budget/);
  assert.equal(decision.validationId, undefined);
  assert.equal(fx.requests.length, 0); // no judgment was ever made on partial data
  assert.equal(fx.compactionValidations.size, 0);
});

test('gates that do not fit one request are split deterministically in gate order', async () => {
  const constraints = Array.from({ length: 5 }, (_, i) => ({
    id: `c-rule-${i}`, createdAt: '2026-01-01', text: `Rule ${i}: ${'r'.repeat(1_500)}`,
  }));
  const evidence = Array.from({ length: 8 }, (_, i) => ({
    id: `e${i}`, source: 'tool', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: `run ${i}: ${'o'.repeat(1_800)}`,
  }));
  const fx = fixtureServices({ initial: snapshot({ constraints, evidence }), reply: responseFor() });
  const h = createHarness(fx.services, { mode: 'enforce' });
  const { decision } = await h.validateCompaction(candidate());
  assert.equal(decision.status, 'ready');
  assert.equal(decision.appliedAction, 'allow');
  assert.match(decision.validationId, /^v-/);
  assert.equal(fx.requests.length, 2); // neither gate was dropped or truncated
  assert.deepEqual(Object.keys(fx.requests[0].state), ['g9-drift']);
  assert.deepEqual(Object.keys(fx.requests[1].state), ['g10-fidelity']);
  // Every standing constraint still reached the judge.
  assert.equal(Object.keys(fx.requests[0].state['g9-drift'].constraints).length, 5);
  assert.equal(fx.requests[1].state['g10-fidelity'].evidence.length, 8);
});
