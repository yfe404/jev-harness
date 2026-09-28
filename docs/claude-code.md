# Claude Code adapter

One dispatcher command (`jh hook claude`) handles every hook event. The installer
adds it to your Claude Code settings; the dispatcher translates each event into
the harness's normalized API and translates decisions back into Claude's exact
hook contract. It never decides a threshold itself.

## What each event does

| Event | Matchers | What the dispatcher does | Can it block? |
| --- | --- | --- | --- |
| `UserPromptSubmit` | (none) | Accepts the authentic request, captures standing rules (G4), detects stop/correction (G5) and freezes tool use; an accepted request whose classification fails re-establishes a fail-closed tool hold | Only adds context — except one narrow block (exit 2): classification failed AND the hold could not be persisted, so the unclassified request must not run |
| `PreToolUse` | `*` | Correction freeze/hold first, then G1/G6 (shell), G2/G6 (write/edit), escalation for unmodeled tools | Yes: `deny` or `ask` |
| `PostToolUse` | `*` | Advisory result screening (G3): warns about injected instructions or likely secrets | **No** — the output already reached the model |
| `Stop` | (none) | Nothing. Never clears a freeze, never blocks (a block would force more agent work) | No |
| `PreCompact` | (none) | Nothing. Per the official hook contract, PreCompact stdout is **not** added to Claude's context and cannot influence the native summary, so the dispatcher stays silent rather than claim a protection that does not exist | No |
| `SessionStart` | `startup\|resume\|clear\|compact` | Re-injects the canonical policy block (goal + standing rules + preserved key decisions) after compaction, clear, or resume | No; advisory context |

Honest limits, stated once and relied on everywhere:

- **PostToolUse is advisory for built-in tools.** Claude Code cannot replace the
  output of `Bash`, `Read`, etc. after execution (`updatedMCPToolOutput` exists
  only for MCP tools, and version-dependent fields are not relied on). A G3
  warning tells the model to treat the output as data; it does not unsend it.
- **PreCompact cannot control the native summary.** The official hook
  contract does not add PreCompact stdout to Claude's context, so no hook
  output can steer what the native summary keeps. The harness preserves your
  rules by restoring the authoritative policy from `.harness/` at
  `SessionStart` (including source `compact`), whose plain-text stdout *is*
  added to Claude's context per the same contract. If the summary drops a
  rule anyway, the restored block still applies. The restored block is the
  same canonical text the compaction validator uses
  (`buildRetainedPolicyBlock`: goal + standing rules + preserved key
  decisions); when it exceeds the injection limit the oldest entries are
  dropped first and the omission is stated on a marker line — never silently
  truncated. Claim and compaction checks are **explicit** (`jh check claim`,
  `jh compact validate`) rather than invisible interception.
- **Hooks are not a sandbox.** A crashed, timed-out, or bypassed hook
  (`--bare`, `disableAllHooks`, untrusted workspace) lets the action proceed.
  Keep OS-level controls (permissions, containers, network rules) in place;
  jev-harness is a second signal, not the boundary.

## Response contract the dispatcher emits

All shapes below follow the official Claude Code hook contract
(<https://code.claude.com/docs/en/hooks>).

- Pass-through: exit 0, empty stdout. It **never** emits
  `permissionDecision: "allow"`, which would bypass Claude's own permission system.
- Gate block: exit 0 with
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`.
  Block reasons name the authorized alternative and state the block is final.
- Escalation: `permissionDecision: "ask"` in interactive permission modes
  (`default`, `acceptEdits`, `plan`); a `deny` with the same reason under
  `bypassPermissions` or headless runs, where a prompt cannot be answered.
- Advisory: `hookSpecificOutput.additionalContext` on `UserPromptSubmit`,
  `PostToolUse`, and `SessionStart`.
- **Error paths fail closed through exit 2.** The official contract treats
  exit 1 as a *non-blocking* error (the tool call proceeds) and exit 2 as the
  one outcome JSON cannot override, so an unevaluable `PreToolUse` — malformed
  payload, unreadable or malformed `.harness/config.json`, internal adapter
  error, or a dispatch that exceeds the internal 12 s deadline (the installed
  hook timeout is 15 s) — exits 2 with the deny JSON still on stdout, in every
  mode. Hook input that cannot even establish its event name exits 2 with a
  generic stderr line; untrusted input is never echoed back.
- Other events fail open on internal errors (pass-through or, for CLI-level
  setup failures, a non-blocking exit 1), because they cannot block anything
  meaningful — and exit 2 on `UserPromptSubmit` would erase your prompt, on
  `Stop` would force more agent work. In shadow mode, gate verdicts are only
  logged; the exit-2 handling above is about unevaluable input, not verdicts.

## Request correlation and freezes

Claude Code gives tool hooks no request identifier, so the dispatcher derives
one per accepted prompt delivery: `requestId = hash(session_id,
transcript_path, prompt, delivery)`. The delivery discriminator is the current
transcript boundary (the id of the last transcript entry) when the transcript
is readable, else fresh entropy. Two separately accepted prompts with
identical text land at different boundaries and are distinct requests — a
repeated prompt after a correction must release the old freeze, not resurrect
it. A hook payload redelivered at the *same* boundary derives the same id, and
core idempotency treats it as a retry: it cannot double-capture a rule and
cannot release a later request's freeze.

Honest limits: the official hook documentation does not state whether a failed
hook execution is ever retried, and notes the transcript is written
asynchronously and may lag the current turn. The transcript boundary is
therefore a best-effort dedup hint: without it, a redelivered prompt is
indistinguishable from a genuinely re-sent one and is conservatively treated
as a new request. The current request id per session is kept in
`.harness/runtime/` (ignored by git); tool events in the same session reuse it.

A correction freeze is session-scoped and survives restarts. It is released
only when a new, authentic user prompt is accepted — never by `Stop`,
`turn_end`-style events, or queued messages. While frozen, **every** tool call
is denied with "reply in text only" guidance. Because acceptance releases a
prior freeze, enforce mode re-establishes a fail-closed hold when the newly
accepted request's classification is unavailable or uncertain: tool use stays
paused until a request is both accepted and successfully classified (or the
owner resets with `jh mode shadow`). If the hold cannot be persisted (the
runtime lock write fails), enforcement is unavailable and that is never an
approval: the hook rejects the current submission with exit 2 (the supported
UserPromptSubmit blocking channel) and an actionable stderr message, instead
of letting the agent run on an unclassified, unheld request. A hold is never
claimed that was not durably recorded.

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

Event field sets, exit-code semantics (including that exit 2 is the only
code that blocks by itself and that exit 1 is non-blocking), the
`deny`/`ask`/advisory JSON shapes, the set of events whose plain-text stdout
reaches Claude (`UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`,
`PostModelSwitch` — notably **not** `PreCompact`), and the per-event exit-2
effects were checked against the official published Claude Code hooks
documentation (<https://code.claude.com/docs/en/hooks>). No claim is made
about any specific binary build, and no private host-project source was used.
Not verified end-to-end (treated conservatively): output replacement for MCP
tools, `ask` behavior under headless `-p`, hook availability for
SDK/subagent prompts, and whether failed hook executions are ever retried.
The adapter is built to remain correct if any of those turn out unsupported.
