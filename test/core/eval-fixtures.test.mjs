import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const evalDir = new URL('../../eval/', import.meta.url);
test('synthetic evaluation fixtures are labelled, parsable, and contain no real credentials', async () => {
  const files = (await readdir(evalDir)).filter(f => f.endsWith('.jsonl'));
  assert.equal(files.length, 9);
  for (const file of files) {
    const raw = await readFile(new URL(file, evalDir), 'utf8');
    const cases = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(cases.length > 1, file);
    assert.equal(new Set(cases.map(c => c.id)).size, cases.length, file);
    assert.ok(cases.every(c => typeof c.expected === 'object'), file);
    assert.equal(/(?:Bearer\s+|ghp_)[A-Za-z0-9]{20,}/.test(raw), false);
  }
});
