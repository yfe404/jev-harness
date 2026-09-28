// Shadow-mode decisions are observations: they must never carry enforce-mode
// finality wording, anti-workaround orders, or owner wait/pause directives.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../../dist/index.js';
import { context, fixtureServices, snapshot } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

const IMPERATIVE = /this block is final|do not work around|do not retry|pause and ask|wait for|reply in text only/i;

const claim = () => ({ context: context(), claim: 'The greeting works', evidenceIds: ['ev-missing'], purpose: 'explicit' });

test('shadow proposed block is labelled an observation without imperative hold text', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const shadow = createHarness(fx.services); // shadow
  const decision = await shadow.checkClaim(claim());
  assert.equal(decision.proposedAction, 'block');
  assert.equal(decision.appliedAction, 'allow');
  assert.match(decision.reason, /Shadow observation only \(no action applied\): would block/);
  assert.doesNotMatch(decision.reason, IMPERATIVE);
  assert.doesNotMatch(decision.alternative ?? '', IMPERATIVE);
});

test('enforce keeps the unchanged finalBlock wording', async () => {
  const fx = fixtureServices({ reply: responseFor() });
  const enforce = createHarness(fx.services, { mode: 'enforce' });
  const decision = await enforce.checkClaim(claim());
  assert.equal(decision.appliedAction, 'block');
  assert.match(decision.reason, /Blocked: .*This block is final; do not work around it\./);
});

test('shadow unavailable decisions carry no owner wait/pause directives', async () => {
  const fx = fixtureServices({ reply: new Error('provider down') });
  const shadow = createHarness(fx.services); // shadow
  const decision = await shadow.onUserInput({ context: context(), text: 'please continue', source: 'user' });
  assert.equal(decision.status, 'unavailable');
  assert.equal(decision.appliedAction, 'allow');
  assert.doesNotMatch(decision.reason, IMPERATIVE);
  assert.doesNotMatch(decision.alternative ?? '', IMPERATIVE);
  assert.match(decision.alternative, /Observation only; no action applied/);
});

test('shadow never persists or clears a freeze from a proposed stop verdict', async () => {
  // A shadow session sharing a runtime with a pre-existing enforce freeze must
  // leave the lock untouched (never cleared) and never freeze on its own.
  const fx = fixtureServices({ reply: responseFor({ noul: { 'g5-stop_stop_or_correct': 0.99 } }) });
  const freezeCtx = context({ requestId: 'request-1' });
  await fx.services.runtime.freeze(freezeCtx);
  const shadow = createHarness(fx.services); // shadow
  const decision = await shadow.onUserInput({ context: context({ requestId: 'request-2' }), text: 'stop what you are doing', source: 'user' });
  assert.equal(decision.proposedAction, 'freeze');
  assert.equal(decision.appliedAction, 'allow');
  assert.match(decision.reason, /Shadow observation only/);
  assert.equal((await fx.services.runtime.get(freezeCtx)).frozen, true, 'the pre-existing freeze is not cleared by shadow');
});
