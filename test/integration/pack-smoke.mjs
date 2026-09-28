// Packaged-tarball smoke test: `npm pack`, install the tarball into an
// isolated prefix with --omit=dev, then verify the shipped CLI, examples, and
// import surfaces work without the repository, a compiler, or any private
// host project. Also scans the tarball for private paths or credentials.
// Offline: the package has no runtime dependencies, so nothing is fetched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname;
const work = await mkdtemp(join(tmpdir(), 'jev-pack-smoke-'));
const failures = [];
const step = (name, fn) => {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL - ${name}: ${error.message}`); }
};
const run = (cmd, args, options) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...options });

try {
  // 1. Pack the tarball.
  const packOut = run('npm', ['pack', REPO, '--pack-destination', work], { cwd: work });
  const tarball = join(work, packOut.trim().split('\n').at(-1).trim());
  console.log(`packed: ${tarball}`);

  // 2. The tarball must not leak private paths or credentials.
  const listing = run('tar', ['-tzf', tarball]);
  step('tarball contains CONTRIBUTING.md, docs, examples, eval, dist', () => {
    for (const required of ['package/CONTRIBUTING.md', 'package/README.md', 'package/LICENSE',
      'package/dist/cli.js', 'package/dist/index.js', 'package/dist/adapters/claude-code/index.js',
      'package/dist/adapters/pi/index.js', 'package/dist/cli/replay.js', 'package/docs/security.md',
      'package/examples/helpers.mjs', 'package/eval/g1-bash.jsonl']) {
      assert.ok(listing.includes(required), `missing ${required}`);
    }
  });
  step('tarball has no test files, private paths, or credential shapes', () => {
    assert.ok(!listing.includes('/test/'), 'tests must not ship');
    assert.ok(!/\/home\/|\/Users\/|\.env|id_rsa|\.pem/.test(listing), 'private path in file list');
    const scan = run('sh', ['-c',
      'tar -xzOf "$1" | grep -aE "Bearer [A-Za-z0-9._-]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|/home/[a-z]+/|/Users/[a-z]+/" | head -5 || true',
      'sh', tarball]);
    assert.equal(scan.trim(), '', `private content in tarball:\n${scan}`);
  });

  // 3. Isolated global-style install without devDependencies, network, or the repo.
  const prefix = join(work, 'prefix');
  run('npm', ['install', '-g', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--offline', tarball], { cwd: work });
  const jh = join(prefix, 'bin', 'jh');

  step('installed jh --help works from the tarball', () => {
    const help = run(jh, ['--help']);
    assert.match(help, /OFFLINE QUICKSTART/);
  });
  step('installed jh runs a bundled example offline with --check', () => {
    const out = run(jh, ['example', 'run', 'no-new-dependencies', '--check'], { cwd: work });
    assert.match(out, /expected output matches/);
  });
  step('installed jh eval validates shipped fixtures', () => {
    const out = run(jh, ['eval'], { cwd: work });
    assert.match(out, /synthetic cases are well-formed/);
  });
  step('jh init/status work in a scratch project', () => {
    const project = join(work, 'scratch');
    run('mkdir', ['-p', project]);
    const init = run(jh, ['init', '--goal', 'smoke test'], { cwd: project });
    assert.match(init, /Initialized jev-harness project/);
    const status = run(jh, ['status'], { cwd: project });
    assert.match(status, /mode:\s+shadow/);
  });

  // 4. Import surfaces from the installed package (no TypeScript, no repo).
  // The importer lives next to the installed package so bare specifiers resolve.
  const importer = join(prefix, 'lib', 'node_modules', 'import-check.mjs');
  await writeFile(importer, `
    import { createHarness, initializeProject, g1Bash, g9Drift } from 'jev-harness';
    import * as pi from 'jev-harness/pi';
    import { dispatchClaudeHook, createMemorySessionStore } from 'jev-harness/claude-code';
    import { createReplayProvider, loadReplayRules } from 'jev-harness/cli/replay';
    for (const value of [createHarness, initializeProject, g1Bash, g9Drift, dispatchClaudeHook,
      createMemorySessionStore, createReplayProvider, loadReplayRules]) {
      if (value === undefined || value === null) throw new Error('missing export');
    }
    if (typeof pi !== 'object' && typeof pi !== 'function') throw new Error('pi adapter missing');
    console.log('imports ok');
  `);
  step('root, /pi, /claude-code, /cli/replay imports resolve from the tarball', () => {
    const out = run(process.execPath, [importer]);
    assert.match(out, /imports ok/);
  });
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} smoke step(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\npack smoke: all steps passed');
}
