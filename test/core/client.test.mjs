import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevClient, validateAnswers, redactText, containsKnownSecret, providerFailureReason, ProviderUnavailableError, runBatchedGates, g1Bash } from '../../dist/index.js';
import { context, fixtureServices, snapshot } from '../support/fixtures.mjs';

const question = { safe: { type: 'noul', instructions: 'Safe?', criteria: { true: 'Yes', false: 'No' } } };
for (const [transport, endpoint, model] of [
  ['typesafe', 'https://api.typesafe.ai/v1/systemone', 'jev-latest'],
  ['openrouter', 'https://openrouter.ai/api/alpha/decisions', 'typesafe/jev-1.13'],
]) {
  test(`${transport} uses the Decisions contract and scrubs state before fetch`, async () => {
    let seen;
    const client = createJevClient({ transport, apiKey: 'fixture-key', fetcher: async (url, options) => {
      seen = { url: String(url), authorization: options.headers.authorization, body: JSON.parse(options.body) };
      return Response.json({ answers: { safe: { noul: 0.8 } } });
    } });
    const key = 'sk-' + 'or-v1-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const answer = await client.decide({ state: { command: `echo ${key}` }, questions: question });
    assert.equal(seen.url, endpoint);
    assert.equal(seen.body.model, model);
    assert.equal(seen.body.state.command.includes(key), false);
    assert.equal(seen.authorization, 'Bearer fixture-key');
    assert.equal(validateAnswers(question, answer).safe.probabilityTrue, 0.8);
  });
}
test('missing credentials, non-HTTPS endpoints, and oversized inputs reject without fetch', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ answers: {} }); };
  await assert.rejects(createJevClient({ env: {}, fetcher }).decide({ state: 'hello', questions: question }), /TYPESAFE_API_KEY/);
  assert.throws(() => createJevClient({ endpoint: 'http://example.com', apiKey: 'fixture-key' }), /HTTPS/);
  const client = createJevClient({ apiKey: 'fixture-key', fetcher, maxRequestBytes: 256 });
  await assert.rejects(client.decide({ state: 'x'.repeat(500), questions: question }), /exceeds/);
  assert.equal(calls, 0);
});
test('cancellation, HTTP error, and malformed responses expose no raw request', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(createJevClient({ apiKey: 'fixture-key', fetcher: async () => { throw Error('unexpected fetch'); } }).decide({ state: {}, questions: question }, cancelled.signal), /cancelled/);
  const unavailable = createJevClient({ apiKey: 'fixture-key', fetcher: async () => new Response('Bearer fake-token-do-not-print', { status: 500 }) });
  await assert.rejects(unavailable.decide({ state: {}, questions: question }), err => /500/.test(err.message) && !/fake-token/.test(err.message));
  const malformed = createJevClient({ apiKey: 'fixture-key', fetcher: async () => Response.json({ noAnswers: true }) });
  await assert.rejects(malformed.decide({ state: {}, questions: question }), /missing answers/);
  const stalled = createJevClient({ apiKey: 'fixture-key', timeoutMs: 20, fetcher: async () => new Promise(() => {}) });
  await assert.rejects(stalled.decide({ state: {}, questions: question }), /timed out/);
  const oversized = createJevClient({ apiKey: 'fixture-key', fetcher: async () => new Response('x'.repeat(70_000)) });
  await assert.rejects(oversized.decide({ state: {}, questions: question }), /transport failed/);
});
test('providerFailureReason maps closed codes to safe, key-identifying diagnostics', () => {
  // Missing key: names the required env var and the restart remedy.
  const missing = new ProviderUnavailableError('missing-api-key', 'Set TYPESAFE_API_KEY', 'TYPESAFE_API_KEY');
  const reason = providerFailureReason(missing);
  assert.match(reason, /TYPESAFE_API_KEY/);
  assert.match(reason, /restart Pi/);
  assert.match(reason, /no provider request was sent/);
  // HTTP status and timeout are distinguishable from each other and from the key case.
  assert.match(providerFailureReason(new ProviderUnavailableError('http-error', 'Jev HTTP 401', '401')), /HTTP 401/);
  assert.match(providerFailureReason(new ProviderUnavailableError('request-timeout', 'x')), /timeout/);
  assert.match(providerFailureReason(new ProviderUnavailableError('invalid-response', 'x')), /invalid or incomplete/);
  assert.match(providerFailureReason(new ProviderUnavailableError('transport-failed', 'x')), /transport failed/);
  // Arbitrary caught messages (attacker-controlled, key-carrying) never leak.
  const evil = new Error('sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 Bearer leaked');
  assert.equal(providerFailureReason(evil), 'Jev verdict is unavailable or invalid');
  assert.equal(providerFailureReason('not even an error'), 'Jev verdict is unavailable or invalid');
  assert.equal(providerFailureReason(new ProviderUnavailableError('bogus', 'sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')), 'Jev verdict is unavailable or invalid');
});

test('runBatchedGates with a real client and env {} surfaces the missing key without any HTTP request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ answers: {} }); };
  const fx = fixtureServices({ initialized: true, reply: { answers: {} } });
  fx.services.provider = createJevClient({ env: {}, fetcher }); // no key anywhere
  const event = { context: context(), callId: 'c1', toolName: 'bash', intent: 'shell', input: { command: 'ls' } };
  const [decision] = await runBatchedGates([{ gate: g1Bash, input: event }], event.context, snapshot(), fx.services, 'enforce');
  assert.equal(calls, 0, 'no HTTP request may be attempted without a key');
  assert.equal(decision.status, 'unavailable');
  assert.match(decision.reason, /API key is not configured/);
  assert.match(decision.reason, /TYPESAFE_API_KEY/);
  const audited = fx.auditEntries.at(-1);
  assert.match(audited.decision.reason, /TYPESAFE_API_KEY/, 'audit carries the same safe diagnostic');
  assert.doesNotMatch(audited.decision.reason, /Bearer|sk-/);
});

test('runBatchedGates keeps HTTP status and timeout failures distinguishable and leak-free', async () => {
  const event = { context: context(), callId: 'c1', toolName: 'bash', intent: 'shell', input: { command: 'ls' } };
  const httpFx = fixtureServices({ reply: { answers: {} } });
  httpFx.services.provider = createJevClient({ apiKey: 'fixture-key', fetcher: async () => new Response('Bearer fake-token', { status: 503 }) });
  const [httpDecision] = await runBatchedGates([{ gate: g1Bash, input: event }], event.context, snapshot(), httpFx.services, 'enforce');
  assert.match(httpDecision.reason, /HTTP 503/);
  assert.doesNotMatch(httpDecision.reason, /fake-token/);
  const slowFx = fixtureServices({ reply: { answers: {} } });
  slowFx.services.provider = createJevClient({ apiKey: 'fixture-key', timeoutMs: 20, fetcher: async () => new Promise(() => {}) });
  const [slowDecision] = await runBatchedGates([{ gate: g1Bash, input: event }], event.context, snapshot(), slowFx.services, 'enforce');
  assert.match(slowDecision.reason, /timeout/);
  // A provider throwing an arbitrary error (possibly carrying secrets) stays generic.
  const evilFx = fixtureServices({ reply: { answers: {} } });
  evilFx.services.provider = { async decide() { throw new Error('sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'); } };
  const [evilDecision] = await runBatchedGates([{ gate: g1Bash, input: event }], event.context, snapshot(), evilFx.services, 'enforce');
  assert.equal(evilDecision.reason, 'Jev verdict is unavailable or invalid');
});

test('providerFailureReason never interpolates forged or unvalidated detail', () => {
  // Forged detail on a real code collapses to the generic phrase; no leak.
  assert.equal(providerFailureReason(new ProviderUnavailableError('http-error', 'x', 'PRIVATE_SENTINEL')), 'Jev verdict is unavailable or invalid');
  assert.equal(providerFailureReason(new ProviderUnavailableError('http-error', 'x', '99')), 'Jev verdict is unavailable or invalid');
  assert.equal(providerFailureReason(new ProviderUnavailableError('http-error', 'x', '600')), 'Jev verdict is unavailable or invalid');
  assert.match(providerFailureReason(new ProviderUnavailableError('http-error', 'x', '404')), /HTTP 404/);
  // Unknown code with a secret-carrying message stays generic.
  assert.equal(providerFailureReason(new ProviderUnavailableError('bogus', 'sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')), 'Jev verdict is unavailable or invalid');
  // Missing-key detail outside the env-var whitelist is never echoed.
  assert.equal(providerFailureReason(new ProviderUnavailableError('missing-api-key', 'x', 'PRIVATE_SENTINEL')), 'Jev verdict is unavailable or invalid');
});

test('ProviderUnavailableError legacy single-message form keeps .message and stays generic', () => {
  const legacy = new ProviderUnavailableError('old unstructured message');
  assert.equal(legacy.message, 'old unstructured message');
  assert.equal(providerFailureReason(legacy), 'Jev verdict is unavailable or invalid');
  // New structured form unchanged.
  const structured = new ProviderUnavailableError('request-cancelled', 'x');
  assert.match(providerFailureReason(structured), /cancelled/);
});

test('auto transport with neither key names both env vars and never calls fetch', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ answers: {} }); };
  const client = createJevClient({ env: {}, fetcher }); // auto, neither key set
  await assert.rejects(client.decide({ state: {}, questions: question }), err => {
    assert.equal(err.code, 'missing-api-key');
    return true;
  });
  assert.equal(calls, 0);
  const reason = providerFailureReason(await client.decide({ state: {}, questions: question }).catch(e => e));
  assert.match(reason, /TYPESAFE_API_KEY/);
  assert.match(reason, /OPENROUTER_API_KEY/);
  // Explicit transports still require their own key only.
  await assert.rejects(createJevClient({ transport: 'openrouter', env: {}, fetcher }).decide({ state: {}, questions: question }), /OPENROUTER_API_KEY/);
  assert.equal(calls, 0);
});

test('timeout precedence: explicit option wins over JH_TIMEOUT_MS, default 15000, strict validation', async () => {
  const envDefault = {};
  // Defaults: no env, no option -> 15000ms configured, reflected in the diagnostic.
  const stalled = createJevClient({ apiKey: 'fixture-key', env: envDefault, fetcher: async () => new Promise(() => {}) });
  const err = await stalled.decide({ state: {}, questions: question }, AbortSignal.timeout(100)).catch(e => e);
  assert.equal(err.code, 'request-cancelled'); // external abort wins before 15s default; no unbounded wait
  // JH_TIMEOUT_MS honoured when no explicit option.
  const envSlow = createJevClient({ apiKey: 'fixture-key', env: { JH_TIMEOUT_MS: '20' }, fetcher: async () => new Promise(() => {}) });
  const timeoutErr = await envSlow.decide({ state: {}, questions: question }).catch(e => e);
  assert.equal(timeoutErr.code, 'request-timeout');
  assert.equal(timeoutErr.detail, '20');
  assert.match(providerFailureReason(timeoutErr), /20 ms/);
  // Explicit option beats env.
  const explicit = createJevClient({ apiKey: 'fixture-key', env: { JH_TIMEOUT_MS: '60000' }, timeoutMs: 20, fetcher: async () => new Promise(() => {}) });
  assert.equal((await explicit.decide({ state: {}, questions: question }).catch(e => e)).detail, '20');
  // Invalid values fail closed at construction: non-integer, out of range, junk env.
  assert.throws(() => createJevClient({ apiKey: 'k', timeoutMs: 0 }), /Invalid Jev timeout/);
  assert.throws(() => createJevClient({ apiKey: 'k', timeoutMs: 60_001 }), /Invalid Jev timeout/);
  assert.throws(() => createJevClient({ apiKey: 'k', timeoutMs: 1.5 }), /Invalid Jev timeout/);
  assert.throws(() => createJevClient({ apiKey: 'k', env: { JH_TIMEOUT_MS: 'abc' } }), /Invalid Jev timeout/);
  assert.throws(() => createJevClient({ apiKey: 'k', env: { JH_TIMEOUT_MS: '999999999999999999999' } }), /Invalid Jev timeout/);
});

test('privacy helpers detect known shapes but do not pretend to be a sandbox', () => {
  assert.equal(containsKnownSecret('password=SomeSecret1234567890'), true);
  assert.equal(containsKnownSecret('API_KEY=YOUR_KEY_HERE'), false);
  assert.equal(redactText('API_KEY=YOUR_KEY_HERE'), '[PUBLIC_PLACEHOLDER]');
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: [REDACTED]');
});
