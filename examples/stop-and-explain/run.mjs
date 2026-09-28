// Example 2 — a correction freezes tool use until a genuinely new request.
// "Stop" pauses every tool; the host's Stop event passes through but never
// clears the freeze; only a newly accepted user prompt releases it — and a
// re-sent prompt with identical text counts as a new request, not a retry.
import { cleanup, claude, hookOutcome, main, makeProject } from '../helpers.mjs';

await main(import.meta.url, async (print) => {
  const root = await makeProject('Refactor the greeting module.');
  try {
    const { dispatch, sessions } = claude(root, new URL('./replay.json', import.meta.url).pathname);
    const edit = {
      hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'tu-1', permission_mode: 'default',
      tool_input: { file_path: 'src/greet.ts', old_string: 'hello', new_string: 'hi' },
    };

    print('# stop-and-explain');
    print('goal: Refactor the greeting module.');
    print('');

    print('> user: "Stop — that is the wrong approach. Explain what you did and why."');
    print(`UserPromptSubmit → ${hookOutcome(await dispatch({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Stop — that is the wrong approach. Explain what you did and why.',
    }))}`);
    print(`request: ${await sessions.currentRequest(root, 'example-session')}`);
    print('');

    print('> agent tries to keep editing anyway');
    print(`PreToolUse(Edit) → ${hookOutcome(await dispatch(edit))}`);
    print('');

    print('> host Stop event fires (agent finished a turn)');
    const stop = await dispatch({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
    print(`Stop → ${hookOutcome(stop)}`);
    print('> agent tries the edit again after Stop');
    print(`PreToolUse(Edit) → ${hookOutcome(await dispatch(edit))}  (Stop never clears a freeze)`);
    print('');

    print('> user sends a genuinely new request: "OK, continue with the greeting refactor"');
    print(`UserPromptSubmit → ${hookOutcome(await dispatch({
      hook_event_name: 'UserPromptSubmit', prompt: 'OK, continue with the greeting refactor',
    }))}`);
    print(`request: ${await sessions.currentRequest(root, 'example-session')}  (new accepted request released the freeze)`);
    print('> agent runs the tests');
    print(`PreToolUse(Bash) → ${hookOutcome(await dispatch({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'npm test' }, tool_use_id: 'tu-2', permission_mode: 'default',
    }))}`);
  } finally {
    await cleanup(root);
  }
});
