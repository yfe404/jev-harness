import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, validateAnswers } from '../dist/index.js';
import { context, fixtureServices, snapshot } from './support/fixtures.mjs';

const call = { context: context(), callId: 'call-1', toolName: 'bash', intent: 'shell', input: { command: 'echo hello' } };

test('uninitialized and untrusted projects remain inert without any provider request', async () => {
  const absent = fixtureServices({ initialized: false });
  const h = createHarness(absent.services, { mode: 'enforce' });
  assert.equal((await h.onToolPreflight(call)).status, 'inert');
  const present = fixtureServices();
  const untrusted = createHarness(present.services, { mode: 'enforce' });
  assert.equal((await untrusted.onToolPreflight({ ...call, context: context({ trusted: false }) })).status, 'inert');
  assert.equal(absent.requests.length + present.requests.length, 0);
  assert.equal(absent.auditEntries.length + present.auditEntries.length, 0);
});

test('initialized project defaults to shadow and audits unavailable gates', async () => {
  const fx = fixtureServices();
  const verdict = await createHarness(fx.services).onToolPreflight(call);
  assert.equal(verdict.proposedAction, 'escalate');
  assert.equal(verdict.appliedAction, 'allow');
  assert.equal(verdict.status, 'unavailable');
  assert.equal(fx.auditEntries[0].decision.appliedAction, 'allow');
  assert.notEqual(fx.auditEntries[0].sessionHash, call.context.sessionId);
});

test('enforcement fails closed when gates or audit are unavailable', async () => {
  const fx = fixtureServices();
  const verdict = await createHarness(fx.services, { mode: 'enforce' }).onToolPreflight(call);
  assert.equal(verdict.appliedAction, 'escalate');
  assert.ok(fx.auditEntries.length >= 1);
  const failed = fixtureServices({ auditFails: true });
  const refused = await createHarness(failed.services, { mode: 'enforce' }).onToolPreflight(call);
  assert.equal(refused.appliedAction, 'escalate');
  assert.match(refused.reason, /[Aa]udit/);
});

test('compaction policy stays separate from actual note text', async () => {
  const fx = fixtureServices({ initial: snapshot({ constraints: [{ id: 'c-1', createdAt: '2026-01-01', text: 'Keep the API public.' }] }) });
  const note = 'Next: add a greeting test.';
  const result = await createHarness(fx.services).validateCompaction({ context: context(), summaryText: '', noteToSelf: note, reason: 'manual' });
  assert.match(result.retainedPolicyBlock, /Keep the API public/);
  assert.doesNotMatch(note, /Keep the API public/);
  assert.equal(fx.getState().summary, null);
  assert.deepEqual(fx.getState().compactionIds, []);
});

test('validates all answer kinds without inventing missing fields', () => {
  const questions = {
    present: { type: 'noul', instructions: 'Present?', criteria: { true: 'Yes', false: 'No' } },
    distance: { type: 'score', instructions: 'Distance?', criteria: ['Near', 'Far'] },
  };
  const ok = validateAnswers(questions, { answers: {
    present: { noul: 0.7 },
    distance: { score: 0.5, confidence: 0.85, probabilities: { '0': 0.5, '1': 0.5 } },
  } });
  assert.equal(ok.present.confidence, 0.7);
  assert.equal(ok.distance.value, 0.5);
  assert.throws(() => validateAnswers(questions, { answers: {
    present: { noul: 1.2 },
    distance: { score: 0, confidence: 0.9, probabilities: { '0': 1, '1': 0 } },
  } }), /probability/);
  assert.throws(() => validateAnswers(questions, { answers: { present: { noul: 0.5 } } }), /Missing answer/);
  assert.throws(() => validateAnswers(questions, { answers: {
    present: { noul: 0.5 }, distance: { score: Number.NaN, confidence: 0.9, probabilities: { '0': 1, '1': 0 } },
  } }), /Invalid score/);
  assert.throws(() => validateAnswers(questions, { answers: {
    present: { noul: 0.5 }, distance: { score: 1, confidence: 0.9, probabilities: { '0': 0.1, '1': 0.1 } },
  } }), /sum to one/);
});

test('validates choice exits and probabilities, rejects missing confidence', () => {
  const questions = { effect: { type: 'choice', instructions: 'Effect?', criteria: { safe: 'Safe', other: 'Other' } } };
  const result = validateAnswers(questions, { answers: { effect: { choice: 'safe', confidence: 0.9, probabilities: { safe: 0.9, other: 0.1 } } } });
  assert.equal(result.effect.label, 'safe');
  assert.throws(() => validateAnswers(questions, { answers: { effect: { choice: 'safe', probabilities: { safe: 0.9, other: 0.1 } } } }), /probability/);
  assert.throws(() => validateAnswers(questions, { answers: { effect: { choice: 'made_up', confidence: 0.9, probabilities: { safe: 0.9, other: 0.1 } } } }), /choice/);
});
