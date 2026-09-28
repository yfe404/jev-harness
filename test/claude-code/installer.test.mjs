import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSettingsFragment, claudeHookStatus, hookCommand, installClaudeHooks, isJevHookEntry,
  quotePosix, uninstallClaudeHooks, CLAUDE_HOOK_EVENTS,
} from '../../dist/adapters/claude-code/index.js';

const PATHS = { nodePath: '/usr/bin/node', cliPath: '/home/a b/jev-harness/dist/cli.js' };

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'jev-install-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return {
    root, home, project,
    options: { scope: 'local', projectRoot: project, homeDir: home, paths: PATHS },
    async done() { await rm(root, { recursive: true, force: true }); },
  };
}

const localFile = box => join(box.project, '.claude', 'settings.local.json');

test('quoting handles spaces and rejects control characters', () => {
  assert.equal(quotePosix('/home/a b/cli.js'), `'/home/a b/cli.js'`);
  assert.equal(quotePosix(`/it's here`), `'/it'\\''s here'`);
  assert.equal(hookCommand(PATHS), `'/usr/bin/node' '/home/a b/jev-harness/dist/cli.js' hook claude`);
  assert.throws(() => quotePosix('bad\npath'), /control character/);
  assert.throws(() => quotePosix('bad\0path'), /control character/);
  assert.throws(() => quotePosix(''), /empty/);
});

test('fragment covers every event with one timeout-bound command each', () => {
  const fragment = buildSettingsFragment(PATHS);
  for (const { event, matcher } of CLAUDE_HOOK_EVENTS) {
    const groups = fragment.hooks[event];
    assert.equal(groups.length, 1, event);
    assert.equal(groups[0].matcher, matcher);
    assert.equal(groups[0].hooks.length, 1);
    assert.equal(groups[0].hooks[0].type, 'command');
    assert.equal(groups[0].hooks[0].timeout, 15);
    assert.ok(isJevHookEntry(groups[0].hooks[0]), event);
  }
  assert.ok(!isJevHookEntry({ type: 'command', command: 'echo hi' }));
  assert.ok(!isJevHookEntry({ type: 'prompt', command: hookCommand(PATHS) }));
});

test('install creates local settings, is byte-identical on rerun, and updates .gitignore once', async () => {
  const box = await sandbox();
  try {
    await writeFile(join(box.project, '.gitignore'), 'node_modules\n');
    const first = await installClaudeHooks(box.options);
    assert.equal(first.action, 'installed');
    const raw = await readFile(localFile(box), 'utf8');
    const parsed = JSON.parse(raw);
    for (const { event } of CLAUDE_HOOK_EVENTS) assert.ok(parsed.hooks[event], event);

    const second = await installClaudeHooks(box.options);
    assert.equal(second.action, 'unchanged');
    assert.equal(await readFile(localFile(box), 'utf8'), raw);

    const gitignore = await readFile(join(box.project, '.gitignore'), 'utf8');
    assert.equal(gitignore, 'node_modules\n.claude/settings.local.json\n');
  } finally { await box.done(); }
});

test('install preserves unrelated hooks and keys; uninstall restores the original file', async () => {
  const box = await sandbox();
  try {
    const original = {
      statusLine: { type: 'command', command: 'status.sh' },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool check' }] },
        ],
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'warm-cache' }] },
        ],
      },
    };
    const file = localFile(box);
    await mkdir(join(box.project, '.claude'), { recursive: true });
    const rawOriginal = `${JSON.stringify(original, null, 2)}\n`;
    await writeFile(file, rawOriginal);

    const report = await installClaudeHooks(box.options);
    assert.equal(report.action, 'installed');
    assert.ok(report.backup);
    const merged = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(merged.statusLine, original.statusLine);
    assert.equal(merged.hooks.PreToolUse.length, 2);
    assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'other-tool check');
    assert.equal(merged.hooks.SessionStart.length, 2);
    assert.equal(merged.hooks.SessionStart[0].hooks[0].command, 'warm-cache');

    const gone = await uninstallClaudeHooks(box.options);
    assert.equal(gone.action, 'uninstalled');
    assert.equal(await readFile(file, 'utf8'), rawOriginal);
  } finally { await box.done(); }
});

test('an existing entry of ours is replaced in place inside a shared group', async () => {
  const box = await sandbox();
  try {
    const file = localFile(box);
    await mkdir(join(box.project, '.claude'), { recursive: true });
    const stale = {
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [
            { type: 'command', command: 'other-tool check' },
            { type: 'command', command: `'/old/node' '/old/jev-harness/dist/cli.js' hook claude`, timeout: 15 },
          ] },
        ],
      },
    };
    await writeFile(file, `${JSON.stringify(stale, null, 2)}\n`);
    await installClaudeHooks(box.options);
    const merged = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(merged.hooks.PreToolUse.length, 1, 'no new group added');
    assert.equal(merged.hooks.PreToolUse[0].hooks.length, 2);
    assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'other-tool check');
    assert.equal(merged.hooks.PreToolUse[0].hooks[1].command, hookCommand(PATHS));

    await uninstallClaudeHooks(box.options);
    const restored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(restored.hooks.PreToolUse.length, 1);
    assert.deepEqual(restored.hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'other-tool check' }]);
  } finally { await box.done(); }
});

test('malformed or surprising settings files are refused without modification', async () => {
  const box = await sandbox();
  try {
    const file = localFile(box);
    await mkdir(join(box.project, '.claude'), { recursive: true });
    await writeFile(file, '{ not json');
    await assert.rejects(installClaudeHooks(box.options), /not valid JSON/);
    assert.equal(await readFile(file, 'utf8'), '{ not json');
    await assert.rejects(uninstallClaudeHooks(box.options), /not valid JSON/);

    await writeFile(file, '{"hooks": 5}');
    await assert.rejects(installClaudeHooks(box.options), /refusing/i);
    assert.equal(await readFile(file, 'utf8'), '{"hooks": 5}');
    const backups = await readdir(join(box.project, '.claude'));
    assert.ok(!backups.some(name => name.endsWith('.jev.bak')), 'no backup or write on refusal');
  } finally { await box.done(); }
});

test('status reports installed events per scope; uninstall on an absent file is a no-op', async () => {
  const box = await sandbox();
  try {
    const before = await claudeHookStatus(box.options);
    assert.equal(before.exists, false);
    assert.ok(before.events.every(e => !e.installed));

    const absent = await uninstallClaudeHooks(box.options);
    assert.equal(absent.action, 'absent');

    await installClaudeHooks(box.options);
    const after = await claudeHookStatus(box.options);
    assert.equal(after.exists, true);
    for (const entry of after.events) {
      assert.ok(entry.installed, entry.event);
      assert.equal(entry.command, hookCommand(PATHS));
    }

    // User scope lives under the home directory, not the project.
    const userOptions = { ...box.options, scope: 'user' };
    await installClaudeHooks(userOptions);
    const userStatus = await claudeHookStatus(userOptions);
    assert.ok(userStatus.file.startsWith(box.home));
    assert.ok(userStatus.events.every(e => e.installed));
  } finally { await box.done(); }
});
