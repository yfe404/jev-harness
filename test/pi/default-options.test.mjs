// Production wiring tests: mode resolution mirrors the CLI (JH_MODE override,
// .harness/config.json at the nearest initialized ancestor), corrupt config
// fails closed, and a symlinked .harness at the session directory is invalid
// state, never bypassed via the parent walk. Hermetic: temp dirs only, an
// injected harness and readState, no provider traffic.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness } from '../../dist/index.js';
import { createDefaultPiHarnessOptions, createPiHarnessExtension } from '../../dist/adapters/pi/index.js';
import { fixtureServices, snapshot } from '../support/fixtures.mjs';
import { responseFor } from '../support/jev-replies.mjs';

async function project({ config } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-pi-root-'));
  await mkdir(join(dir, '.harness'));
  if (config !== undefined) await writeFile(join(dir, '.harness', 'config.json'), config);
  const nested = join(dir, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  return { dir, nested, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function host(options, { cwd }) {
  const fx = fixtureServices({ initialized: true, reply: responseFor(), initial: snapshot() });
  const harness = createHarness(fx.services, { mode: 'enforce' });
  const handlers = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
  };
  const bridge = {};
  const notifications = [];
  createPiHarnessExtension({
    ...options,
    harness, // never construct the real provider client in tests
    readState: async () => fx.getState(),
    bridge,
  })(pi);
  const ctx = {
    cwd, mode: 'json', hasUI: false, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => 'sess-1', getBranch: () => [] },
    ui: { notify: (message, type) => notifications.push({ message, type }), setStatus: () => {} },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  return { emit, bridge, notifications };
}

const ENV = { JEVC_DISABLED: '1', TYPESAFE_API_KEY: '', OPENROUTER_API_KEY: '' };

test('mode comes from .harness/config.json at the nearest initialized ancestor of the cwd', async () => {
  const { dir, nested, cleanup } = await project({ config: JSON.stringify({ mode: 'enforce' }) });
  try {
    const h = host(createDefaultPiHarnessOptions(ENV), { cwd: nested });
    await h.emit('session_start', { reason: 'startup' });
    assert.equal(h.bridge.mode(), 'enforce', 'config file at the root ancestor governs a nested cwd');
    assert.equal(h.bridge.currentContext().projectRoot, dir);
  } finally { await cleanup(); }
});

test('JH_MODE overrides the config file; a corrupt config fails closed to enforce', async () => {
  const corrupt = JSON.stringify({ mode: 'bogus' });
  const { dir, nested, cleanup } = await project({ config: corrupt });
  try {
    // Explicit valid env override: the corrupt file is never consulted.
    const overridden = host(createDefaultPiHarnessOptions({ ...ENV, JH_MODE: 'shadow' }), { cwd: nested });
    await overridden.emit('session_start', { reason: 'startup' });
    assert.equal(overridden.bridge.mode(), 'shadow');
    assert.equal(await overridden.emit('tool_call', { toolCallId: 't', toolName: 'bash', input: {} }), undefined);

    // Without an override the corrupt config resolves to a fail-closed
    // enforce hold, never the silent default shadow.
    const failed = host(createDefaultPiHarnessOptions(ENV), { cwd: nested });
    await failed.emit('session_start', { reason: 'startup' });
    assert.equal(failed.bridge.mode(), 'enforce');
    const blocked = await failed.emit('tool_call', { toolCallId: 't', toolName: 'bash', input: {} });
    assert.equal(blocked.block, true, 'corrupt initialized config must not pass everything');
    assert.ok(failed.notifications.some(n => n.type === 'warning'));
  } finally { await cleanup(); }
});

test('a symlinked .harness at the session directory is invalid state, not bypassed via the parent', async () => {
  const { dir, cleanup } = await project({ config: JSON.stringify({ mode: 'shadow' }) });
  const elsewhere = await mkdtemp(join(tmpdir(), 'jev-pi-elsewhere-'));
  const victim = join(dir, 'worktree');
  await mkdir(victim);
  await symlink(join(dir, '.harness'), join(victim, '.harness'), 'dir');
  try {
    // The session directory itself carries a symlinked .harness: this is
    // corruption at the session root, never a reason to adopt the parent's
    // project (here the parent walk would find dir/.harness).
    const h = host(createDefaultPiHarnessOptions({ ...ENV, JH_MODE: 'enforce' }), { cwd: victim });
    await h.emit('session_start', { reason: 'startup' });
    const blocked = await h.emit('tool_call', { toolCallId: 't', toolName: 'bash', input: {} });
    assert.equal(blocked.block, true, 'symlinked .harness is blocked in enforce, not bypassed');
    assert.match(blocked.reason, /symbolic link|unavailable/);
  } finally { await cleanup(); await rm(elsewhere, { recursive: true, force: true }); }
});
