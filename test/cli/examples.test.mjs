// Every bundled example must run offline and match its committed expected output.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

const EXAMPLES = new URL('../../examples/', import.meta.url).pathname;

function runExample(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`${EXAMPLES}${name}/run.mjs`, '--check'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`example ${name} timed out`)); }, 30_000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('four offline examples are bundled', async () => {
  const names = (await readdir(EXAMPLES)).filter(n => !n.includes('.'));
  assert.deepEqual(names.sort(), [
    'claim-observed-tests-only', 'no-new-dependencies', 'policy-survives-compaction', 'stop-and-explain',
  ]);
});

for (const name of ['no-new-dependencies', 'stop-and-explain', 'policy-survives-compaction', 'claim-observed-tests-only']) {
  test(`example ${name} matches its expected output`, async () => {
    const { code, stdout, stderr } = await runExample(name);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /# expected output matches/);
  });
}
