# Claude Code adapter

One dispatcher command (`jh hook claude`) handles every hook event. The installer
adds it to your Claude Code settings; the dispatcher translates each event into
the harness's normalized API and translates decisions back into Claude's exact
hook contract. It never decides a threshold itself.

## What each event does

| Event | Matchers | What the dispatcher does | Can it block? |
| --- | --- | --- | --- |
| `UserPromptSubmit` | (none) | Accepts the authentic request, captures standing rules (G4), detects stop/correction (G5) and freezes tool use | Never blocks your prompt; it only adds context |
| `PreToolUse` | `*` | Correction freeze first, then G1/G6 (shell), G2/G6 (write/edit), escalation for unmodeled tools | Yes: `deny` or `ask` |
| `PostToolUse` | `*` | Advisory result screening (G3): warns about injected instructions or likely secrets | **No** — the output already reached the model |
| `Stop` | (none) | Nothing. Never clears a freeze, never blocks (a block would force more agent work) | No |
| `PreCompact` | (none) | Prints plain-text "preserve these rules" guidance appended to the native summary's instructions | **No** — it cannot see, veto, or replace the summary |
| `SessionStart` | `startup\|resume\|clear\|compact` | Re-injects the canonical policy block (goal + standing rules) after compaction, clear, or resume | No; advisory context |

Honest limits, stated once and relied on everywhere:

- **PostToolUse is advisory for built-in tools.** Claude Code cannot replace the
  output of `Bash`, `Read`, etc. after execution (`updatedMCPToolOutput` exists
  only for MCP tools, and version-dependent fields are not relied on). A G3
  warning tells the model to treat the output as data; it does not unsend it.
- **PreCompact cannot control the native summary.** The harness preserves your
  rules by (a) printing preservation guidance into the summary instructions and
  (b) restoring the authoritative policy from `.harness/` at `SessionStart`
  with source `compact`. If the summary drops a rule anyway, the restored block
  still applies. Claim and checkpoint checks are **explicit** (`jh claim`,
  `jh compact`) rather than invisible interception.
- **Hooks are not a sandbox.** A crashed, timed-out, or bypassed hook
  (`--bare`, `disableAllHooks`, untrusted workspace) lets the action proceed.
  Keep OS-level controls (permissions, containers, network rules) in place;
  jev-harness is a second signal, not the boundary.

## Response contract the dispatcher emits

- Pass-through: exit 0, empty stdout. It **never** emits
  `permissionDecision: "allow"`, which would bypass Claude's own permission system.
- Block: exit 0 with
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`.
  Block reasons name the authorized alternative and state the block is final.
- Escalation: `permissionDecision: "ask"` in interactive permission modes
  (`default`, `acceptEdits`, `plan`); a `deny` with the same reason under
  `bypassPermissions` or headless runs, where a prompt cannot be answered.
- Advisory: `hookSpecificOutput.additionalContext` on `UserPromptSubmit`,
  `PostToolUse`, and `SessionStart`.
- Enforce-mode internal failure on `PreToolUse` (unparseable input, adapter
  error): a `deny` with a sanitized reason. All other events fail open, because
  they cannot block anything meaningful. In shadow mode everything fails open
  and verdicts are only logged.

## Request correlation and freezes

Claude Code gives tool hooks no request identifier, so the dispatcher derives
one: `requestId = hash(session_id, transcript_path, prompt)`. A retried prompt
hook maps to the same id and is not reprocessed (no duplicate captures, no
resurrected freezes). The current request id per session is kept in
`.harness/runtime/` (ignored by git); tool events in the same session reuse it.

A correction freeze is session-scoped and survives restarts. It is released
only when a new, authentic user prompt is accepted — never by `Stop`,
`turn_end`-style events, or queued messages. While frozen, **every** tool call
is denied with "reply in text only" guidance.

## Installation

`jh install claude [--scope local|project|user]` (default `local`,
`.claude/settings.local.json`; also `--print` to inspect the fragment without
writing). The installer:

- writes one dispatcher entry per event with a 15 s timeout;
- uses absolute, single-quoted paths (`process.execPath` and the installed
  `dist/cli.js`), so spaces in paths are safe and no agent-controlled text ever
  enters the command string;
- merges idempotently: running it twice produces a byte-identical file;
- preserves unrelated hooks, groups, keys, and key order, and replaces only its
  own entries (identified by the `jev-harness … hook claude` command shape);
- refuses malformed settings files instead of overwriting them;
- keeps a `.jev.bak` backup and writes atomically (temp file, fsync, rename);
- removes only its own entries on `jh uninstall claude`.

After install, note the warnings the installer prints: hooks run only in
trusted workspaces and are disabled by `--bare`/`disableAllHooks`.

## Verification status

Event field sets, exit-code semantics, and the `deny`/`ask`/advisory JSON
shapes were checked against the installed Claude Code **2.1.283** binary's
embedded hook documentation and behave as described in
`test/claude-code/` fixtures. Not verified locally (treated conservatively):
output replacement for MCP tools, `PreCompact` exit-2 semantics, `ask` behavior
under headless `-p`, and hook availability for SDK/subagent prompts. The
adapter is built to remain correct if any of those turn out unsupported.
