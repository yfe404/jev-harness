# Gate reference

Ten gates, each a small module with its own questions, numeric thresholds, and
a pure evaluator. Jev answers the questions; **code** applies the thresholds.
An answer below the gate's `human` confidence threshold escalates to the owner
instead of guessing. Code declarations in `src/core/gates/` are authoritative.

"Automatic" below means a host hook (Claude Code today) triggers the gate with
no agent cooperation. "Explicit" means the owner or agent runs a `jh` command.
In shadow mode every gate only audits a proposal; blocking happens in enforce.

## G1 — shell command effect (`g1-bash`)

- **Trigger:** automatic `PreToolUse` for shell tools; explicit `jh check shell`.
- **Questions:** effect (read_only / reversible / irreversible / long_lived /
  other); does the command advance something a standing constraint prohibits?
- **Thresholds:** block 0.7, confirm 0.65, human 0.55.
- **Actions:** `block` (irreversible, or constraint conflict), `confirm`
  (long-lived external action), `escalate` (unclassified), `allow`.

## G2 — secret-bearing writes (`g2-write`)

- **Trigger:** automatic `PreToolUse` for write/edit tools; explicit
  `jh check write`. Known credential shapes are blocked by code before the
  gate runs; `.harness/`, out-of-project, and private-path writes are blocked
  without any provider call.
- **Questions:** would this change persist a credential or session material?
- **Thresholds:** block 0.7, human 0.55.

## G3 — tool-result screening (`g3-result`)

- **Trigger:** automatic `PostToolUse`. In Claude Code this is **advisory
  only**: built-in tool output cannot be replaced, so findings arrive as
  additional context after the model saw the output.
- **Questions:** does the output include a real credential? does it contain
  instructions addressed to the agent (prompt injection)?
- **Thresholds:** injection 0.7, secret 0.7, human 0.55.
- **Actions:** `redact` (only where the host can replace output), `remind`
  (treat output as data, not instructions).

## G4 — standing-rule capture (`g4-capture`)

- **Trigger:** automatic `UserPromptSubmit`; explicit `jh constraints add`.
- **Questions:** is this user message an enduring project rule?
- **Thresholds:** capture 0.7, human 0.55.
- Captured rules are stored verbatim in `.harness/constraints.md` with id and
  date. Wording containing a credential is paused for a safe rephrase.

## G5 — correction freeze (`g5-stop`)

- **Trigger:** automatic `UserPromptSubmit`.
- **Questions:** is the user asking the agent to stop, or correcting its
  current approach?
- **Thresholds:** freeze 0.7, human 0.6.
- A freeze blocks **every** tool until a new, authentic, accepted user request
  releases it. `Stop`, turn boundaries, queued input, and extension messages
  never release it; there is no automatic clearing.
- **Fail-closed hold:** accepting a new request releases a prior freeze, so in
  enforce mode the adapter re-establishes the hold when the new request's
  classification is unavailable or uncertain — a freeze is never silently
  released without a successful classification.

## G6 — plan/goal relation (`g6-plan`)

- **Trigger:** automatic on every shell/write/edit preflight (a first harmless
  action grants no standing exemption); explicit via the `jh check` commands.
- **Questions:** which standing constraint does this action violate (if any)?
  how does it serve the owner's goal (direct / unblock / detour / substitution
  / none)?
- **Thresholds:** block 0.7, human 0.55.
- **Actions:** `block` (constraint conflict), `halt` (goal substitution),
  `remind` (detour — explain the path back), `allow`.

## G7 — attempt dedup (`g7-dedup`)

- **Trigger:** explicit `jh attempts register`.
- **Questions:** how does this proposed test relate to each prior attempt —
  pending or settled (repeat / variant / unrelated) — and would a repeat
  change the conclusion?
- **Thresholds:** repeat 0.8, matters 0.4, human 0.55. Comparisons are capped
  at 255 prior attempts, 8 concurrent; partial coverage is marked on the
  decision and requires owner review in enforce.
- A registered attempt starts `inconclusive` and does not count as a trial
  until observed harness evidence settles it. Pending attempts are still
  compared for dedup — grading arrives later, so an ungraded exact repeat is
  refused with a reference to the prior attempt's id, hypothesis, and method
  — without ever being marked a counted trial. Only actual `setup_failure`
  attempts are excluded from comparison.

## G8 — claim vs. observed evidence (`g8-claim`)

- **Trigger:** explicit `jh check claim`.
- **Questions:** does the cited observed evidence support the exact wording?
  how strong a causal assertion is made (observation / association / cause)?
- **Thresholds:** supported 0.6, human 0.55, causal 1.5.
- Code blocks claims with no cited evidence and paired comparisons that vary
  more than the named variable, before any judgment call.

## G9 — compaction drift (`g9-drift`)

- **Trigger:** explicit `jh compact validate`; host compaction seams.
- **Questions:** does the candidate rewrite the owner's stated goal? how does
  its next action relate to the goal (direct / supporting / detour / other /
  none)? does a detour have a credible path back? a 0–4 drift score? which
  standing constraint would it drop? which preserved decision does it reverse?
- **Thresholds:** rewrite 0.7, drop 0.7, detour 0.7, path-back 0.7, remind at
  drift score 2, replan at 3, human 0.55.
- **Actions:** `block` (goal rewrite, dropped constraint, reversed decision),
  `replan` (detour without a path back, drift score ≥ 3), `remind` (drift
  score ≥ 2), `escalate` (uncertain), `allow`.
- Judges the actual candidate bytes; never generates or rewrites prose.

## G10 — compaction fidelity (`g10-fidelity`)

- **Trigger:** same as G9.
- **Questions:** does the candidate assert outcomes the recorded attempts and
  observed evidence do not support? does it contradict a recorded observation?
- **Thresholds:** contradict 0.7, block 0.85, warn 0.6, human 0.55. Judges
  against the most recent 25 attempts and 25 evidence entries.

## Verdict anatomy

Every decision carries `gateId`, `mode`, `proposedAction` (the gate's
judgment), `appliedAction` (what the adapter may do — `allow`/`none` in
shadow), `status` (`ready` / `inert` / `unavailable` / `escalation`), a
human-readable `reason`, named `probabilities`, and an authorized
`alternative` for blocks. Verdicts are audited **before** being applied;
audit entries contain hashes and probabilities, never raw prompts or outputs.
