// Shared helpers for the bundled offline examples.
// Every example runs against a temporary project with synthetic replay answers:
// they demonstrate wiring and thresholds, never live Jev judgment.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHarness, initializeProject, createFileStateService,
  createFileRuntimeService, createFileAuditService,
} from '../dist/index.js';
import { createReplayProvider, loadReplayRules } from '../dist/cli/replay.js';
import { dispatchClaudeHook, createMemorySessionStore } from '../dist/adapters/claude-code/index.js';
import { formatDecision } from '../dist/cli/commands.js';

export { dispatchClaudeHook };

/** Mask the random ids the harness generates so example output is deterministic. */
export function mask(text) {
  return String(text)
    .replace(/\b(c|a|e)-[0-9a-f-]{12}\b/g, '$1-<id>')
    .replace(/\breq-[0-9a-f]{24}\b/g, 'req-<id>')
    .replace(/\(\d{4}-\d{2}-\d{2}\)/g, '(<date>)')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<timestamp>');
}

export async function makeProject(goal) {
  const root = await mkdtemp(join(tmpdir(), 'jev-example-'));
  await initializeProject(root, goal);
  return root;
}

export function wire(root, replayFile, { mode = 'enforce', host = 'claude-code' } = {}) {
  const context = {
    host, projectRoot: root, sessionId: 'example-session', requestId: 'req-example', trusted: true,
  };
  const harness = createHarness({
    provider: createReplayProvider(loadReplayRules(replayFile)),
    state: createFileStateService(),
    runtime: createFileRuntimeService(),
    audit: createFileAuditService(context),
  }, { mode });
  return { context, harness };
}

/** A Claude-flavoured dispatcher bound to one project and replay script. */
export function claude(root, replayFile, options = {}) {
  const { harness } = wire(root, replayFile, options);
  const sessions = createMemorySessionStore();
  return {
    sessions,
    dispatch: (event) => dispatchClaudeHook(
      { session_id: 'example-session', cwd: root, ...event },
      { harness, mode: options.mode ?? 'enforce', env: {}, sessions }),
  };
}

/** Summarize a HookResponse the way the docs describe it. */
export function hookOutcome(response) {
  if (!response.stdout) return 'pass (exit 0, no output — action proceeds)';
  if (!response.stdout.trimStart().startsWith('{')) {
    return `plain stdout:\n${response.stdout.trimEnd().split('\n').map(l => `    ${l}`).join('\n')}`;
  }
  const out = JSON.parse(response.stdout).hookSpecificOutput;
  if (out.permissionDecision) {
    return `${out.permissionDecision.toUpperCase()} — ${out.permissionDecisionReason}`;
  }
  return `advisory (${out.hookEventName}): ${out.additionalContext}`;
}

export function showDecision(decision) {
  return mask(formatDecision(decision));
}

/** Bounded foreground execution with capped output, mirroring `jh evidence observe`. */
export function execute(command, cwd, timeoutMs = 20_000) {
  const CAP = 2_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < CAP) stdout += String(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < CAP) stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

/**
 * Run an example: `node run.mjs` prints the transcript; `node run.mjs --check`
 * compares it against expected.txt and exits non-zero on any difference.
 */
export async function main(callerUrl, run) {
  const lines = [];
  try {
    await run(line => lines.push(mask(line)));
  } catch (error) {
    lines.push(`EXAMPLE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  const output = lines.join('\n') + '\n';
  if (process.argv.includes('--check')) {
    const expected = await readFile(new URL('./expected.txt', callerUrl), 'utf8');
    if (output === expected) {
      process.stdout.write(output + `# expected output matches\n`);
      return;
    }
    process.stdout.write(output);
    process.stderr.write(`\n--- expected ---\n${expected}\nOutput does not match expected.txt\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(output);
}

export async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}
