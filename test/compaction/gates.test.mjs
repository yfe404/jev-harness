import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRetainedPolicyBlock, compactionCandidateHash, createHarness, replayVerdict } from '../../dist/index.js';
import { g9Drift } from '../../dist/core/gates/g9-drift.js';
import { g10Fidelity } from '../../dist/core/gates/g10-fidelity.js';
import { context, fixtureServices, snapshot } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

const rules = [
  { id: 'c-nodeps', createdAt: '2026-01-01', text: 'Do not add dependencies.' },
  { id: 'c-style', createdAt: '2026-01-01', text: 'Keep the existing code style.' },
];
const checkpoint = {
  goalRef: 'Make the sample app greet the user.', rules: [], hypotheses: [], attempts: [],
  keyDecisions: ['Use the local fixture server, never the live API.'], inProgress: 'greeting', nextAction: 'pick a font',
};
const candidate = (overrides = {}) => ({
  context: context(), summaryText: 'Greeting implemented per the constraints.', reason: 'manual', ...overrides,
});
const stateWith = (overrides = {}) => snapshot({ constraints: rules, summary: checkpoint, ...overrides });

test('G9 blocks a candidate that drops a standing constraint and replays offline', async () => {
  const fx = fixtureServices({ initial: stateWith(), reply: responseFor({ choice: { 'g9-drift_dropped_constraint': 'c-nodeps' } }) });
  const { decision, retainedPolicyBlock } = await createHarness(fx.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(decision.gateId, 'g9-drift');
  assert.equal(decision.proposedAction, 'block');
  assert.match(decision.reason, /c-nodeps: Do not add dependencies\./);
  assert.equal(decision.validationId, undefined);
  assert.match(retainedPolicyBlock, /c-style \(2026-01-01\): Keep the existing code style\./);
  assert.match(retainedPolicyBlock, /Preserved decisions:\n- Use the local fixture server/);
  assert.equal(replayVerdict(g9Drift, candidate(), fx.getState(), fx.auditEntries[0].answers, fx.auditEntries[0].decision), true);
});

test('G9 blocks a goal rewrite and a reversed preserved decision', async () => {
  const rewritten = fixtureServices({ initial: stateWith(), reply: responseFor({ noul: { 'g9-drift_goal_rewrite': 0.9 } }) });
  const denied = await createHarness(rewritten.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(denied.decision.proposedAction, 'block');
  assert.match(denied.decision.reason, /rewrites the owner's stated goal/);
  assert.equal(denied.decision.validationId, undefined);
  const reversed = fixtureServices({ initial: stateWith(), reply: responseFor({ choice: { 'g9-drift_reversed_decision': 'd0' } }) });
  const denial = await createHarness(reversed.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(denial.decision.proposedAction, 'block');
  assert.match(denial.decision.reason, /local fixture server/);
});

test('G9 reminds at drift score 2 and replans at 3 or on a detour without a path back', async () => {
  const drifting = fixtureServices({ initial: stateWith(), reply: responseFor({ score: { 'g9-drift_drift_score': 3 } }) });
  const replan = await createHarness(drifting.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(replan.decision.proposedAction, 'replan');
  assert.equal(replan.decision.validationId, undefined);
  const wandering = fixtureServices({ initial: stateWith(), reply: responseFor({ score: { 'g9-drift_drift_score': 2 } }) });
  const remind = await createHarness(wandering.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(remind.decision.proposedAction, 'remind');
  assert.match(remind.decision.validationId, /^v-/); // a reminder still yields an ack-able validation
  const detour = fixtureServices({ initial: stateWith(), reply: responseFor({
    choice: { 'g9-drift_next_action_relation': 'detour' }, noul: { 'g9-drift_path_back': 0.1 },
  }) });
  const lost = await createHarness(detour.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(lost.decision.proposedAction, 'replan');
  assert.match(lost.decision.reason, /no path back/);
  const excursion = fixtureServices({ initial: stateWith(), reply: responseFor({
    choice: { 'g9-drift_next_action_relation': 'detour' }, noul: { 'g9-drift_path_back': 0.95 },
  }) });
  const found = await createHarness(excursion.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(found.decision.appliedAction, 'allow');
  assert.match(found.decision.validationId, /^v-/);
});

test('G9 escalates on uncertain drift judgment', async () => {
  const fx = fixtureServices({ initial: stateWith(), reply: responseFor({ noul: { 'g9-drift_goal_rewrite': 0.5 } }) });
  const { decision } = await createHarness(fx.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(decision.appliedAction, 'escalate');
  assert.equal(decision.status, 'escalation');
  assert.equal(decision.validationId, undefined);
});

test('G10 blocks contradiction, warns on unsupported claims, and replays offline', async () => {
  const ledger = stateWith({ evidence: [
    { id: 'e1', source: 'harness', observedAt: '2026-01-02T00:00:00Z', method: 'npm test', observation: 'greeting test failed', result: 'refuted' },
  ] });
  const contra = fixtureServices({ initial: ledger, reply: responseFor({ noul: { 'g10-fidelity_contradicts_evidence': 0.9 } }) });
  const blocked = await createHarness(contra.services, { mode: 'enforce' }).validateCompaction(candidate({ summaryText: 'All greeting tests pass.' }));
  assert.equal(blocked.decision.gateId, 'g10-fidelity');
  assert.equal(blocked.decision.proposedAction, 'block');
  assert.equal(replayVerdict(g10Fidelity, candidate({ summaryText: 'All greeting tests pass.' }), contra.getState(), contra.auditEntries[1].answers, contra.auditEntries[1].decision), true);
  const warned = fixtureServices({ initial: ledger, reply: responseFor({ noul: { 'g10-fidelity_unsupported_facts': 0.7 } }) });
  const reminder = await createHarness(warned.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(reminder.decision.proposedAction, 'remind');
  assert.match(reminder.decision.validationId, /^v-/); // a warning still yields an ack-able validation
  const fabricated = fixtureServices({ initial: ledger, reply: responseFor({ noul: { 'g10-fidelity_unsupported_facts': 0.9 } }) });
  const denied = await createHarness(fabricated.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(denied.decision.proposedAction, 'block');
  assert.equal(denied.decision.validationId, undefined);
});

test('canonical policy block is deterministic and candidate identity tracks exact bytes', async () => {
  const state = stateWith();
  assert.equal(buildRetainedPolicyBlock(state), buildRetainedPolicyBlock(state));
  const without = stateWith({ constraints: [], summary: null });
  const block = buildRetainedPolicyBlock(without);
  assert.equal(block, '[jev-harness canonical policy — authoritative over any compaction summary]\nGoal: Make the sample app greet the user.');
  const a = candidate({ noteToSelf: 'note v1' });
  assert.notEqual(compactionCandidateHash(a), compactionCandidateHash({ ...a, noteToSelf: 'note v2' }));
  assert.notEqual(compactionCandidateHash(a), compactionCandidateHash({ ...a, summaryText: `${a.summaryText} ` }));
  assert.equal(compactionCandidateHash(a), compactionCandidateHash({ ...a, reason: 'overflow' })); // reason is not candidate bytes
});

test('absent typed checkpoint is audited as absent, never backfilled', async () => {
  const fx = fixtureServices({ initial: stateWith({ summary: null }), reply: responseFor() });
  const { decision } = await createHarness(fx.services, { mode: 'enforce' }).validateCompaction(candidate());
  assert.equal(decision.appliedAction, 'allow');
  const sent = fx.requests[0].state['g10-fidelity'];
  assert.equal(sent.candidate.checkpoint, null);
  assert.equal(fx.getState().summary, null);
});
