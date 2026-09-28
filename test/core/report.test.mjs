import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileAuditService, initializeProject, loadAudit, replayVerdict, redactValue, createHarness } from '../../dist/index.js';
import { g1Bash } from '../../dist/core/gates/g1-bash.js';
import { context, fixtureServices } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

test('session-scoped audit is durable and excludes raw command and credential', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeProject(root, 'Make a greeting function.');
  const ctx = context({ projectRoot: root, host: 'pi' });
  const provider = fixtureServices({ reply: responseFor() });
  const audit = createFileAuditService(ctx);
  const h = createHarness({ ...provider.services, audit }, { mode: 'enforce' });
  const input = { context: ctx, callId: 'call-1', toolName: 'bash', intent: 'shell', input: { command: 'npm test' } };
  await h.onToolPreflight(input);
  const { readdir } = await import('node:fs/promises');
  const [name] = await readdir(join(root, '.harness', 'audit'));
  const path = join(root, '.harness', 'audit', name);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('npm test'), false);
  assert.equal(raw.includes(ctx.sessionId), false);
  const entries = await loadAudit(path);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(e => e.decision && e.stateHash));
  assert.equal(replayVerdict(g1Bash, input, provider.getState(), entries[0].answers, entries[0].decision), true);
});
test('redaction bounds, cycles, and known secrets are not logged verbatim', () => {
  const token = 'sk-' + 'or-v1-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  assert.equal(JSON.stringify(redactValue({ q: token })).includes(token), false);
  const circular = {}; circular.self = circular;
  assert.throws(() => redactValue(circular), /Cyclic/);
  assert.throws(() => redactValue({ q: 'x'.repeat(30_000) }), /exceeds/);
});
