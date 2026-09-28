// Example 4 — a claim must cite observed evidence.
// "The tests pass" is blocked while it cites nothing. The harness then runs
// the test command itself and records exactly what it observed (exit code and
// output), and only then does the same claim pass — worded as what was
// observed.
//
// Trust boundary, stated plainly: the `jh evidence observe` CLI records the
// observation only — it can never attach a confirmed/refuted result, because
// an exit code alone is not experiment evidence and a caller-supplied result
// would be a forged outcome. This script is different: it is trusted
// owner-side embedding code that declares its expectation up front (exit 0
// AND the expected output) and uses the core recordEvidence API, which only
// trusted embeddings may call with a result.
// Offline: synthetic replay answers; the observed command really executes.
import { randomUUID } from 'node:crypto';
import { cleanup, execute, main, makeProject, showDecision, wire } from '../helpers.mjs';

await main(import.meta.url, async (print) => {
  const root = await makeProject('Make the greeting tests pass.');
  try {
    const { context, harness } = wire(root, new URL('./replay.json', import.meta.url).pathname, { host: 'cli' });
    const method = 'node -e "greeting test"';

    print('# claim-observed-tests-only');
    print('goal: Make the greeting tests pass.');
    print('');

    print('> register the attempt before running anything');
    const registered = await harness.registerAttempt({
      context, hypothesis: 'The greeting test passes', method,
    });
    print(showDecision(registered));
    const attemptId = registered.recordedId;
    print('');

    print('> claim with no observed evidence: "The greeting tests pass"');
    print(showDecision(await harness.checkClaim({
      context, claim: 'The greeting tests pass', evidenceIds: [], purpose: 'explicit',
    })));
    print('');

    print('> the harness executes the test command and observes it');
    print('  (trusted embedding API: the expectation below is declared before running;');
    print('   the jh CLI can only record the observation, never grade it)');
    const run = await execute(process.execPath === '' ? ['node'] : [process.execPath, '-e', "console.log('greet: 1 passed')"], root);
    const observation = `exit ${run.code}; stdout: ${run.stdout || '(empty)'}; stderr: ${run.stderr || '(empty)'}`;
    // Declared expectation: exit 0 AND the expected line in the output. Only a
    // match attaches a trial result; anything else is an observation alone.
    const matched = run.code === 0 && /greet: 1 passed/.test(run.stdout);
    const evidence = {
      id: `e-${randomUUID().slice(0, 12)}`,
      source: 'harness', observedAt: new Date().toISOString(), method, observation,
      ...(matched ? { result: 'confirmed' } : {}),
    };
    print(`observed: ${observation}`);
    print(showDecision(await harness.recordEvidence({
      context, evidence, attemptId, ...(matched ? { result: 'confirmed' } : {}),
    })));
    print('');

    print('> the same claim, now citing the observed evidence');
    print(showDecision(await harness.checkClaim({
      context, claim: 'The greeting test passed in the observed run', evidenceIds: [evidence.id], purpose: 'explicit',
    })));
  } finally {
    await cleanup(root);
  }
});
