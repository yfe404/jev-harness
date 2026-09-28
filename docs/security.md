# Security model and limits

jev-harness is **advisory enforcement around a coding agent**, not a sandbox.
This page states exactly what it protects and where the boundaries are.

## Trust model

- **The project owner is trusted.** `jh init`, `jh mode`, `jh constraints add`,
  and hook installation are explicit owner operations. The owner can always
  edit `.harness/` files directly, uninstall hooks, or delete state.
- **The model/agent is not trusted.** It may not set `EventContext` fields,
  grant itself constraint exceptions, mark plans reviewed, clear freezes, or
  attach trial results to evidence. Those fields and transitions are
  adapter/harness-owned.
- **The decision provider (Jev) is bounded, not authoritative.** It answers
  fixed System One questions; code validates every answer against the question
  shapes and applies numeric thresholds. Malformed or missing answers become
  `unavailable`, which escalates in enforce mode — never a guessed approval.
- **Host hooks are the delivery mechanism, not a boundary.** Claude Code runs
  hooks only in workspaces you trust, and disables them with `--bare` or
  `disableAllHooks`. A crashed or timed-out hook lets the action proceed
  (fail-open at the host level). Keep the host's own permission system and
  OS-level isolation in place; jev-harness adds judgment, not containment.

## What happens to your data

- **State lives in your project.** `.harness/goal.md`, `constraints.md`,
  `attempts.jsonl`, `summary.json` are plain text, meant for review and version
  control. `.harness/runtime/` (locks, session correlation, compaction
  registry) and `.harness/audit/` (verdict logs) are git-ignored.
- **What leaves the machine:** redacted gate state and question text sent to
  the configured Jev endpoint, capped at 24 KB per request. Known credential
  shapes are redacted before sending; private paths (`.env`, key files, …) are
  excluded from remote judgment by path classification. A redaction filter is
  not a guarantee that arbitrary secrets cannot leave the machine — do not
  rely on it as your only control.
- **What never leaves by design:** API keys (environment-only), `goal.md`
  beyond gate state, audit logs, runtime locks. The audit log stores hashes of
  session/request ids and validated probabilities — no raw prompts, commands,
  or tool outputs.
- **Offline mode sends nothing.** `--replay` / `JH_REPLAY` answers gates from a
  local script; the examples and tests run this way.

## Enforcement boundaries

- **Fail closed where it matters.** A `PreToolUse` call the hook cannot
  parse or evaluate — malformed payload, broken `.harness/config.json`,
  internal adapter error, or a dispatch that exceeds the hook deadline (12 s,
  below the installed 15 s host timeout) — is denied with exit 2 plus a deny
  JSON, in every mode. Per the official Claude Code hook contract, exit 2 is
  the only exit code that blocks by itself; a bare exit 1 is a non-blocking
  error and the tool call would proceed, so error paths never use it for
  `PreToolUse`. (Shadow mode still never applies a *gate verdict*; an input
  no gate could evaluate is not a verdict.) Provider/state/audit/registry
  failures escalate in enforce mode; protected `.harness/` writes and
  out-of-project writes are blocked before any provider call; writes to
  private credential paths are blocked. Hook input that fails these checks is
  never echoed back in error output.
- **Fail open where blocking is impossible.** `PostToolUse` in Claude Code is
  advisory only — built-in tool output cannot be replaced, so screening adds
  context after the fact; it does not sanitize what the model already saw.
  `PreCompact` stdout is not added to Claude's context and cannot influence
  the native summary's instructions (official hook contract), so the
  dispatcher stays silent there rather than claim a protection that does not
  exist; canonical policy is re-injected at `SessionStart`.
- **Freeze semantics.** A correction freeze blocks every tool until a *new,
  authentic, accepted* user request releases it. `Stop`, turn boundaries,
  queued input, and extension messages never release it. Repeated identical
  prompts are distinct accepted requests (per-delivery request ids), so a
  re-sent prompt cannot impersonate a retry of an old one. Because acceptance
  releases a prior freeze, the Claude adapter **re-establishes a fail-closed
  hold** when the new request's classification is unavailable or uncertain in
  enforce mode — tool use stays paused until a later request is accepted *and*
  classified, or the owner resets explicitly. If that hold cannot be
  persisted (the runtime lock write fails), the hook rejects the current
  submission with exit 2 — the supported UserPromptSubmit blocking channel —
  with an actionable stderr message, rather than letting the agent run on an
  unclassified, unheld request; a hold is never claimed that was not durably
  recorded. A redelivered hook payload seen
  at the same transcript boundary dedupes to the same request id and is
  treated as a retry, so a duplicate delivery cannot release a later freeze;
  when no transcript boundary exists, a redelivery is indistinguishable from a
  genuinely re-sent prompt and is conservatively treated as a new request
  (documented limit).
- **Evidence provenance.** Only `source: "harness"` evidence — data the
  harness itself executed and observed — can carry a trial result or settle an
  attempt, and the core rejects any caller-supplied `result` that does not
  come from such evidence. `jh evidence observe` records **observations
  only**: the exact command, exit code, and bounded output. It has no
  `--result` flag at all, because an exit code alone is not experiment
  evidence and a caller-supplied classification would be a forged outcome.
  Grading an experiment (attaching `confirmed`/`refuted`) is reserved for a
  trusted embedding of the core `recordEvidence` API whose owner configured
  the exact executable, method, and expectation up front — that embedding,
  not the harness, is the trust boundary for grading. Observed commands run
  with a sanitized environment (no inherited credentials), without a shell,
  with bounded capture, and on timeout the whole process tree is killed.
  Execution happens only for initialized projects; in shadow mode the
  execution is explicit and user-requested, and nothing is persisted.
- **Compaction provenance.** `acknowledgeCompaction` requires a prior
  successful validation bound to the same project, session, request, mode, and
  state revision; forged, stale, mismatched, and double-consumed
  acknowledgments are rejected. Candidate prose is never stored in the
  registry (hashes only) and never rewritten by the gates.

## Operational guidance

- Start in shadow, read the audit log (`.harness/audit/*.jsonl`,
  `jh replay <file>`), then opt into enforce per project.
- Rollback: `jh uninstall claude` (removes only our entries, keeps `.jev.bak`),
  `jh mode shadow`, or delete `.harness/`.
- Report vulnerabilities privately to the maintainers; do not open public
  issues containing credentials or private paths.
