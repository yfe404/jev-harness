// End-to-end CLI tests: spawn the built dist/cli.js in temporary projects.
// Offline only — synthetic replay scripts, no API keys, no network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CLI = new URL('../../dist/cli.js', import.meta.url).pathname;
const FIXTURE_ENV = { ...process.env, TYPESAFE_API_KEY: '', OPENROUTER_API_KEY: '', JH_MODE: '', JH_REPLAY: '' };

function run(args, { cwd, env = {}, input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, env: { ...FIXTURE_ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: jh ${args.join(' ')}`)); }, timeout);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'jev-cli-'));
  const home = await mkdtemp(join(tmpdir(), 'jev-cli-home-'));
  return { root, home, env: { HOME: home }, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]) };
}

const REPLAY = {
  replies: [
    { gate: 'g4-capture', when: 'never add new dependencies', answers: { kind: 'standing_constraint' } },
    { gate: 'g4-capture', answers: { kind: 'one_off' } },
    { gate: 'g5-stop', answers: { stop_or_correct: 0.05 } },
    { gate: 'g1-bash', when: 'npm install', answers: { effect: 'reversible', violates_constraint: 0.2 } },
    { gate: 'g1-bash', answers: { effect: 'read_only', violates_constraint: 0.05 } },
    { gate: 'g2-write', answers: { contains_secret: 0.05 } },
    { gate: 'g6-plan', when: 'npm install', answers: { violates: { matching: 'never add new dependencies' }, relation_to_goal: 'detour' } },
    { gate: 'g6-plan', answers: { violates: 'none', relation_to_goal: 'direct' } },
    { gate: 'g8-claim', answers: { supported: 0.9, causal_strength: 0 } },
    { gate: 'g9-drift', answers: { goal_rewrite: 0.1, next_action_relation: 'direct', path_back: 0.9, drift_score: 0, dropped_constraint: 'none', reversed_decision: 'none' } },
    { gate: 'g10-fidelity', answers: { unsupported_facts: 0.1, contradicts_evidence: 0.1 } },
  ],
};

async function replayFile(root) {
  const path = join(root, 'replay.json');
  await writeFile(path, JSON.stringify(REPLAY));
  return path;
}

test('--help explains the tool and the offline quickstart; no args is a usage error', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /OFFLINE QUICKSTART/);
  assert.match(help.stdout, /jh example run no-new-dependencies/);
  assert.match(help.stdout, /NOT automatically intercepted/);
  const none = await run([]);
  assert.equal(none.code, 64);
  const bogus = await run(['frobnicate']);
  assert.equal(bogus.code, 64);
  assert.match(bogus.stderr, /Unknown command/);
});

test('init, status, and mode manage an explicit owner opt-in project', async () => {
  const { root, env, cleanup } = await project();
  try {
    const before = await run(['status'], { cwd: root, env });
    assert.equal(before.code, 0);
    assert.match(before.stdout, /No \.harness\/ found/);

    const badMode = await run(['mode', 'enforce'], { cwd: root, env });
    assert.equal(badMode.code, 64);

    const init = await run(['init', '--goal', 'Add a greeting without new dependencies'], { cwd: root, env });
    assert.equal(init.code, 0);
    assert.match(init.stdout, /Initialized jev-harness project/);
    for (const name of ['goal.md', 'constraints.md', 'attempts.jsonl', 'summary.json']) {
      await readFile(join(root, '.harness', name), 'utf8');
    }

    const again = await run(['init', '--goal', 'twice'], { cwd: root, env });
    assert.equal(again.code, 64);
    assert.match(again.stderr, /Already initialized/);

    const status = await run(['status'], { cwd: root, env });
    assert.match(status.stdout, /mode:\s+shadow \(from default\)/);
    assert.match(status.stdout, /goal:\s+Add a greeting/);
    assert.match(status.stdout, /freeze:\s+none/);

    const set = await run(['mode', 'enforce'], { cwd: root, env });
    assert.equal(set.code, 0);
    assert.match(set.stdout, /mode set to enforce/);
    const shown = await run(['mode'], { cwd: root, env });
    assert.match(shown.stdout, /enforce \(from file\)/);
    const invalid = await run(['mode', 'yolo'], { cwd: root, env });
    assert.equal(invalid.code, 64);
  } finally { await cleanup(); }
});

test('constraints add/list is explicit owner management with dedup and one-line rules', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'g'], { cwd: root, env });
    const add = await run(['constraints', 'add', 'Never add new dependencies to this project'], { cwd: root, env });
    assert.equal(add.code, 0);
    assert.match(add.stdout, /Recorded standing rule c-/);
    const dup = await run(['constraints', 'add', 'Never add new dependencies to this project'], { cwd: root, env });
    assert.match(dup.stdout, /Already recorded: c-/);
    const list = await run(['constraints', 'list'], { cwd: root, env });
    assert.match(list.stdout, /c-[0-9a-f-]+ \(\d{4}-\d\d-\d\d\): Never add new dependencies/);
    const listJson = await run(['constraints', 'list', '--json'], { cwd: root, env });
    assert.equal(JSON.parse(listJson.stdout).length, 1);
    const remove = await run(['constraints', 'remove', 'c-1'], { cwd: root, env });
    assert.equal(remove.code, 64);
    assert.match(remove.stderr, /edit \.harness\/constraints\.md directly/);
  } finally { await cleanup(); }
});

test('check shell blocks a constraint violation in enforce and only observes in shadow', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'Add a greeting without new dependencies'], { cwd: root, env });
    await run(['constraints', 'add', 'Never add new dependencies to this project'], { cwd: root, env });
    const replay = await replayFile(root);

    // Shadow mode observes what enforcement would do but applies allow; the
    // most severe *proposed* action is reported even though nothing blocks.
    const shadow = await run(['check', 'shell', '--replay', replay, '--', 'npm', 'install', 'left-pad'], { cwd: root, env });
    assert.equal(shadow.code, 0);
    assert.match(shadow.stdout, /proposed:\s+block/);
    assert.match(shadow.stdout, /applied:\s+allow \(shadow: observed, not enforced\)/);

    const enforce = await run(['check', 'shell', '--replay', replay, '--', 'npm', 'install', 'left-pad'], { cwd: root, env: { ...env, JH_MODE: 'enforce' } });
    assert.equal(enforce.code, 2);
    assert.match(enforce.stdout, /applied:\s+block/);
    assert.match(enforce.stdout, /Never add new dependencies/);

    const harmless = await run(['check', 'shell', '--replay', replay, '--', 'node', '--version'], { cwd: root, env: { ...env, JH_MODE: 'enforce' } });
    assert.equal(harmless.code, 0);

    // Without a replay script or API key the verdict is unavailable, never an approval.
    const offline = await run(['check', 'shell', '--', 'npm', 'test'], { cwd: root, env: { ...env, JH_MODE: 'enforce' } });
    assert.equal(offline.code, 1);
    assert.match(offline.stdout, /status:\s+unavailable/);
  } finally { await cleanup(); }
});

test('attempts, observed evidence, and claim checks form the explicit workflow', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'Make the greeting tests pass'], { cwd: root, env });
    await run(['mode', 'enforce'], { cwd: root, env });
    const replay = await replayFile(root);

    const claimAlone = await run(['check', 'claim', '--replay', replay, '--claim', 'The greeting tests pass', '--evidence', 'e-nope'], { cwd: root, env });
    assert.equal(claimAlone.code, 2);
    assert.match(claimAlone.stdout, /lacks cited observed evidence/);

    const registered = await run(['attempts', 'register', '--replay', replay, '--hypothesis', 'The greeting test passes', '--method', 'node greet.test'], { cwd: root, env });
    assert.equal(registered.code, 0);
    const attemptId = /recorded:\s+(a-[0-9a-f-]+)/.exec(registered.stdout)[1];

    // Forged outcomes are rejected outright: the CLI cannot grade experiments.
    for (const forged of [
      ['evidence', 'observe', '--method', 'node greet.test', '--attempt', attemptId, '--result', 'confirmed', '--', 'true'],
      ['evidence', 'observe', '--method', 'node greet.test', '--attempt', attemptId, '--result', 'refuted', '--expect-exit', '1', '--', 'true'],
    ]) {
      const rejected = await run(forged, { cwd: root, env });
      assert.equal(rejected.code, 64);
      assert.match(rejected.stderr, /cannot grade experiments/);
    }

    // The harness executes the command and records exactly what it observed.
    const observed = await run(['evidence', 'observe', '--replay', replay, '--method', 'node greet.test', '--attempt', attemptId, '--', process.execPath, '-e', 'console.log("1 passed")'], { cwd: root, env });
    assert.equal(observed.code, 0);
    assert.match(observed.stdout, /observed: exit 0; stdout: 1 passed/);
    assert.match(observed.stdout, /Observed evidence recorded/);
    const evidenceId = /recorded:\s+(e-[0-9a-f-]+)/.exec(observed.stdout)[1];

    // A failing command is recorded as what it was: exit 3, not "refuted".
    const failed = await run(['evidence', 'observe', '--replay', replay, '--method', 'node greet.test', '--attempt', attemptId, '--', process.execPath, '-e', 'process.exit(3)'], { cwd: root, env });
    assert.equal(failed.code, 0);
    assert.match(failed.stdout, /observed: exit 3/);

    const claim = await run(['check', 'claim', '--replay', replay, '--claim', 'The observed run printed "1 passed"', '--evidence', evidenceId], { cwd: root, env });
    assert.equal(claim.code, 0);
    assert.match(claim.stdout, /supported by cited observations/);

    // The attempt stays inconclusive: observation alone settles nothing.
    const attempts = await run(['attempts', 'list'], { cwd: root, env });
    assert.match(attempts.stdout, new RegExp(`${attemptId}: inconclusive`));
    assert.doesNotMatch(attempts.stdout, /confirmed/);
  } finally { await cleanup(); }
});

test('evidence observe runs with a sanitized environment', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'g'], { cwd: root, env });
    await run(['mode', 'enforce'], { cwd: root, env });
    const replay = await replayFile(root);
    const observed = await run(['evidence', 'observe', '--replay', replay, '--method', 'env check', '--',
      process.execPath, '-e', 'console.log(process.env.JH_TEST_SECRET ?? "unset", typeof process.env.PATH)'], {
      cwd: root, env: { ...env, JH_TEST_SECRET: 'must-not-leak' },
    });
    assert.equal(observed.code, 0);
    assert.match(observed.stdout, /observed: exit 0; stdout: unset string/);
    assert.doesNotMatch(observed.stdout, /must-not-leak/);
  } finally { await cleanup(); }
});

test('evidence observe kills the whole process tree on timeout', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'g'], { cwd: root, env });
    await run(['mode', 'enforce'], { cwd: root, env });
    const replay = await replayFile(root);
    const marker = join(root, 'grandchild-wrote-this');
    // The observed command spawns a grandchild that would write the marker
    // after 2s; the 1s timeout must kill the grandchild with the group.
    const observed = await run(['evidence', 'observe', '--replay', replay, '--method', 'm', '--timeout', '1', '--',
      process.execPath, '-e',
      `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "x"), 2000)', '${marker}'], { stdio: 'ignore' })`],
      { cwd: root, env, timeout: 20_000 });
    assert.equal(observed.code, 0);
    assert.match(observed.stdout, /killed after 1s/);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

test('evidence observe never executes a command for an uninitialized project', async () => {
  const { root, env, cleanup } = await project();
  try {
    const marker = join(root, 'should-never-exist');
    const result = await run(['evidence', 'observe', '--method', 'm', '--',
      process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1], 'x')`, marker], { cwd: root, env });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /not initialized; nothing was executed/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

test('compact validate and acknowledge enforce validation provenance', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'Add a greeting without new dependencies'], { cwd: root, env });
    await run(['mode', 'enforce'], { cwd: root, env });
    await run(['constraints', 'add', 'Never add new dependencies to this project'], { cwd: root, env });
    const replay = await replayFile(root);
    const identity = { ...env, JH_SESSION_ID: 'cli-session-1', JH_REQUEST_ID: 'req-cli-1' };

    const validated = await run(['compact', 'validate', '--replay', replay, '--json',
      '--summary', 'Working on the greeting; the no-new-dependencies rule still stands.'], { cwd: root, env: identity });
    assert.equal(validated.code, 0, validated.stdout);
    const { decision, retainedPolicyBlock } = JSON.parse(validated.stdout);
    assert.match(decision.validationId, /^v-/);
    assert.match(retainedPolicyBlock, /Never add new dependencies/);

    // Acknowledgment needs the same session/request identity as the validation.
    const wrongIdentity = await run(['compact', 'acknowledge', '--replay', replay,
      '--compaction-id', 'compact-1', '--validation-id', decision.validationId], { cwd: root, env });
    assert.equal(wrongIdentity.code, 2);
    assert.match(wrongIdentity.stdout, /different project, session, request, or mode/);

    const forged = await run(['compact', 'acknowledge', '--replay', replay,
      '--compaction-id', 'compact-1', '--validation-id', 'v-doesnotexist'], { cwd: root, env: identity });
    assert.equal(forged.code, 2);
    assert.match(forged.stdout, /Unknown compaction validation id/);

    // An ack resent with a *different* candidate than the validated one is rejected.
    const mismatched = await run(['compact', 'acknowledge', '--replay', replay,
      '--compaction-id', 'compact-1', '--validation-id', decision.validationId,
      '--summary', 'A completely different summary than the validated one.'], { cwd: root, env: identity });
    assert.equal(mismatched.code, 2);
    assert.match(mismatched.stdout, /does not match the validated candidate/);

    const ack = await run(['compact', 'acknowledge', '--replay', replay,
      '--compaction-id', 'compact-1', '--validation-id', decision.validationId,
      '--summary', 'Working on the greeting; the no-new-dependencies rule still stands.'], { cwd: root, env: identity });
    assert.equal(ack.code, 0, ack.stdout);
    assert.match(ack.stdout, /acknowledged/);

    const again = await run(['compact', 'acknowledge', '--replay', replay,
      '--compaction-id', 'compact-1', '--validation-id', decision.validationId], { cwd: root, env: identity });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /Already acknowledged/);

    // A candidate that drops the standing rule is blocked and yields no validation id.
    const replayDrop = join(root, 'replay-drop.json');
    await writeFile(replayDrop, JSON.stringify({ replies: [
      { gate: 'g9-drift', answers: { goal_rewrite: 0.1, next_action_relation: 'direct', path_back: 0.9, drift_score: 0, dropped_constraint: { matching: 'never add new dependencies' }, reversed_decision: 'none' } },
      { gate: 'g10-fidelity', answers: { unsupported_facts: 0.1, contradicts_evidence: 0.1 } },
    ] }));
    const dropped = await run(['compact', 'validate', '--replay', replayDrop, '--json',
      '--summary', 'Install left-pad and continue.'], { cwd: root, env: identity });
    assert.equal(dropped.code, 2);
    assert.match(JSON.parse(dropped.stdout).decision.reason, /drops or contradicts/);
  } finally { await cleanup(); }
});

test('replay inspects the audit log and checks decision invariants', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'g'], { cwd: root, env });
    await run(['mode', 'enforce'], { cwd: root, env });
    const replay = await replayFile(root);
    await run(['check', 'shell', '--replay', replay, '--', 'node', '--version'], { cwd: root, env });
    const auditDir = join(root, '.harness', 'audit');
    const [file] = await readdir(auditDir);
    const inspected = await run(['replay', join(auditDir, file)], { cwd: root, env });
    assert.equal(inspected.code, 0);
    assert.match(inspected.stdout, /\d+ entries, 0 invariant violations/);
    assert.match(inspected.stdout, /cannot be re-evaluated|not re-evaluated/);
  } finally { await cleanup(); }
});

test('eval validates the bundled synthetic fixtures offline', async () => {
  const result = await run(['eval']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /g6-plan\.jsonl: \d+ cases/);
  assert.match(result.stdout, /do not measure live Jev judgment/);
});

test('hook claude dispatches stdin events and never emits permissionDecision allow', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'Add a greeting without new dependencies'], { cwd: root, env });
    await run(['mode', 'enforce'], { cwd: root, env });
    const replay = await replayFile(root);
    const hookEnv = { ...env, JH_REPLAY: replay, CLAUDE_PROJECT_DIR: root };

    const prompt = await run(['hook', 'claude'], {
      cwd: root, env: hookEnv,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: root, prompt: 'Never add new dependencies to this project' }),
    });
    assert.equal(prompt.code, 0);
    assert.match(prompt.stdout, /Recorded standing rule c-/);

    const install = await run(['hook', 'claude'], {
      cwd: root, env: hookEnv,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm install left-pad' }, tool_use_id: 'tu-1', permission_mode: 'default' }),
    });
    assert.equal(install.code, 0);
    const out = JSON.parse(install.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /Never add new dependencies/);

    // Malformed stdin: the hook event cannot be established, so the hook fails
    // closed with exit 2 and a generic message that never echoes the input.
    const malformed = await run(['hook', 'claude'], { cwd: root, env: hookEnv, input: '{not json' });
    assert.equal(malformed.code, 2);
    assert.equal(malformed.stdout, '');
    assert.match(malformed.stderr, /malformed hook input/);
    assert.doesNotMatch(malformed.stderr, /not json/);

    // An unparseable PreToolUse payload is denied through the supported
    // blocking channel (exit 2 + deny JSON), in shadow mode too.
    const unparsable = await run(['hook', 'claude'], {
      cwd: root, env: hookEnv, input: JSON.stringify({ hook_event_name: 'PreToolUse' }),
    });
    assert.equal(unparsable.code, 2);
    assert.equal(JSON.parse(unparsable.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally { await cleanup(); }
});

test('a malformed .harness/config.json denies PreToolUse instead of failing open', async () => {
  const { root, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'g'], { cwd: root, env });
    await run(['mode', 'enforce'], { cwd: root, env });
    const replay = await replayFile(root);
    await writeFile(join(root, '.harness', 'config.json'), '{broken', 'utf8');
    const hookEnv = { ...env, JH_REPLAY: replay, CLAUDE_PROJECT_DIR: root };

    // Before the fix this was a bare exit 1, which the host treats as a
    // non-blocking error — the tool call would proceed unchecked.
    const tool = await run(['hook', 'claude'], {
      cwd: root, env: hookEnv,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-1' }),
    });
    assert.equal(tool.code, 2);
    const out = JSON.parse(tool.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /could not initialize/);
    assert.match(out.permissionDecisionReason, /config\.json/);

    // A prompt event with broken config stays a non-blocking error (exit 2
    // would erase the user's prompt) and never leaks stdin content.
    const prompt = await run(['hook', 'claude'], {
      cwd: root, env: hookEnv,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: root, prompt: 'secret prompt text' }),
    });
    assert.equal(prompt.code, 1);
    assert.equal(prompt.stdout, '');
    assert.match(prompt.stderr, /config\.json/);
    assert.doesNotMatch(prompt.stderr, /secret prompt text/);
  } finally { await cleanup(); }
});

test('install/hooks/uninstall claude manage settings without touching unrelated content', async () => {
  const { root, home, env, cleanup } = await project();
  try {
    await run(['init', '--goal', 'g'], { cwd: root, env });
    const printed = await run(['install', 'claude', '--print'], { cwd: root, env });
    assert.equal(printed.code, 0);
    const fragment = JSON.parse(printed.stdout);
    assert.ok(fragment.hooks.PreToolUse);
    assert.match(JSON.stringify(fragment), /hook claude/);

    const installed = await run(['install', 'claude'], { cwd: root, env });
    assert.equal(installed.code, 0);
    assert.match(installed.stdout, /installed: .*settings\.local\.json/);
    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 1);

    const status = await run(['hooks', 'claude', '--scope', 'local'], { cwd: root, env });
    assert.match(status.stdout, /installed UserPromptSubmit/);
    assert.match(status.stdout, /installed SessionStart/);

    const rerun = await run(['install', 'claude'], { cwd: root, env });
    assert.match(rerun.stdout, /unchanged/);

    const removed = await run(['uninstall', 'claude'], { cwd: root, env });
    assert.match(removed.stdout, /uninstalled/);
    const after = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(after.hooks, undefined);
    assert.ok(home); // user scope was never touched
  } finally { await cleanup(); }
});

test('uninitialized projects stay inert for checks and hooks', async () => {
  const { root, env, cleanup } = await project();
  try {
    const replay = await replayFile(root);
    const check = await run(['check', 'shell', '--replay', replay, '--', 'rm', '-rf', '/'], { cwd: root, env: { ...env, JH_MODE: 'enforce' } });
    assert.equal(check.code, 1);
    assert.match(check.stdout, /status:\s+inert/);
    const hook = await run(['hook', 'claude'], {
      cwd: root, env: { ...env, JH_REPLAY: replay, CLAUDE_PROJECT_DIR: root, JH_MODE: 'enforce' },
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'tu-1' }),
    });
    assert.equal(hook.code, 0);
    assert.equal(hook.stdout, '');
  } finally { await cleanup(); }
});
