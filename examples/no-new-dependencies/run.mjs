// Example 1 — an owner rule is captured verbatim and then enforced.
// A user states "never add new dependencies"; the harness records it as a
// standing constraint, and a later `npm install` is denied while a harmless
// command passes. Offline: synthetic replay answers, temporary project.
import { cleanup, claude, hookOutcome, main, makeProject } from '../helpers.mjs';

await main(import.meta.url, async (print) => {
  const root = await makeProject('Add a greeting to the CLI without changing any dependencies.');
  try {
    const { dispatch } = claude(root, new URL('./replay.json', import.meta.url).pathname);

    print('# no-new-dependencies');
    print('goal: Add a greeting to the CLI without changing any dependencies.');
    print('');

    print('> user: "Never add new dependencies to this project"');
    print(`UserPromptSubmit → ${hookOutcome(await dispatch({
      hook_event_name: 'UserPromptSubmit', prompt: 'Never add new dependencies to this project',
    }))}`);
    print('');

    print('> agent tries: npm install left-pad');
    print(`PreToolUse(Bash) → ${hookOutcome(await dispatch({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'npm install left-pad' }, tool_use_id: 'tu-1', permission_mode: 'default',
    }))}`);
    print('');

    print('> agent tries: node --version');
    print(`PreToolUse(Bash) → ${hookOutcome(await dispatch({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'node --version' }, tool_use_id: 'tu-2', permission_mode: 'default',
    }))}`);
  } finally {
    await cleanup(root);
  }
});
