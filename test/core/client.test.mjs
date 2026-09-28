import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevClient, validateAnswers, redactText, containsKnownSecret } from '../../dist/index.js';

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
test('privacy helpers detect known shapes but do not pretend to be a sandbox', () => {
  assert.equal(containsKnownSecret('password=SomeSecret1234567890'), true);
  assert.equal(containsKnownSecret('API_KEY=YOUR_KEY_HERE'), false);
  assert.equal(redactText('API_KEY=YOUR_KEY_HERE'), '[PUBLIC_PLACEHOLDER]');
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: [REDACTED]');
});
