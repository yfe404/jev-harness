// Example 3 — a public-API constraint survives context compaction.
// The owner rule lives in .harness/, not in the model's context. PreCompact
// cannot see or edit the native summary (its stdout never reaches Claude per
// the official hook contract), so the dispatcher stays silent there; the
// protection is SessionStart re-injecting the canonical policy afterwards —
// so the edit that breaks the public API is still denied after a compact.
// Offline, synthetic.
import { cleanup, claude, hookOutcome, main, makeProject } from '../helpers.mjs';

await main(import.meta.url, async (print) => {
  const root = await makeProject('Expose a stable greeting API.');
  try {
    const { dispatch } = claude(root, new URL('./replay.json', import.meta.url).pathname);

    print('# policy-survives-compaction');
    print('goal: Expose a stable greeting API.');
    print('');

    print('> user: "The public API in src/api.ts must stay backward compatible"');
    print(`UserPromptSubmit → ${hookOutcome(await dispatch({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'The public API in src/api.ts must stay backward compatible',
    }))}`);
    print('');

    print('> context is compacted (PreCompact cannot see or edit the native summary)');
    print(`PreCompact → ${hookOutcome(await dispatch({
      hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null,
    }))}`);
    print('');

    print('> new session context starts after the compact');
    print(`SessionStart(source=compact) → ${hookOutcome(await dispatch({
      hook_event_name: 'SessionStart', source: 'compact',
    }))}`);
    print('');

    print('> agent tries to change the public API signature after the compact');
    print(`PreToolUse(Edit src/api.ts) → ${hookOutcome(await dispatch({
      hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'tu-1', permission_mode: 'default',
      tool_input: { file_path: 'src/api.ts', old_string: 'export function greet(name: string)', new_string: 'export function greet(user: User)' },
    }))}`);
  } finally {
    await cleanup(root);
  }
});
