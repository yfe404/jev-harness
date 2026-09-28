# Jev Harness

Jev Harness sits between a coding agent (Claude Code or Pi) and its actions,
and enforces rules you set for the project.

The concrete case: you tell the agent **"Do not add dependencies."** The
harness records that rule. When the agent later proposes `npm install`, the
harness checks the rule first and — in enforce mode — blocks the command
before it runs, with the reason written to a local audit log.

Excerpt from `node dist/cli.js example run no-new-dependencies` (offline,
replay answers, no API key):

```
> user: "Never add new dependencies to this project"
UserPromptSubmit → advisory: [jev-harness] Recorded standing rule c-<id>.
> agent tries: npm install left-pad
PreToolUse(Bash) → DENY — Blocked: Action conflicts with c-<id>: Never add new dependencies to this project.
> agent tries: node --version
PreToolUse(Bash) → pass (exit 0 — action proceeds)
```

What it does, in short: owner rules are captured verbatim, plans and commands
are checked against them, a correction freezes tool use until a genuinely new
request, compaction candidates are audited for drift, and claims must cite
evidence the harness itself observed. Judgments come from
[Jev](https://typesafe.ai) System One (or an offline replay script); **all
thresholds and actions are code**, so a verdict can be inspected, replayed,
and tested without a model in the loop.

**Status: early. Shadow mode is the default, projects opt in explicitly, and no
live accuracy has been measured.** Offline contract tests prove the wiring and
thresholds, not Jev's judgment. Treat enforcement as uncalibrated until a live
evaluation is run and published.

## Quickstart (offline, no API key)

Requires Node 24+.

```sh
git clone https://github.com/yfe404/jev-harness.git
cd jev-harness
npm ci && npm run build          # or: just install && just build
node dist/cli.js --help          # what the tool is and does
node dist/cli.js example list    # four runnable offline examples
node dist/cli.js example run no-new-dependencies
node dist/cli.js eval            # validate the synthetic fixtures
```

The examples run against a temporary project with synthetic replay answers and
print exactly what the gates decided and why:

| Example | Shows |
| --- | --- |
| `no-new-dependencies` | an owner rule is captured verbatim, then `npm install` is denied while a harmless command passes |
| `stop-and-explain` | a correction freezes all tool use; `Stop` never clears it; only a new accepted request does |
| `policy-survives-compaction` | a public-API constraint is re-injected after compaction and still blocks a breaking edit |
| `claim-observed-tests-only` | a "tests pass" claim is blocked until the harness itself executes and observes the test run |

## Using it in a project

Put `jh` on PATH first (the package has no runtime dependencies). It is not
on the npm registry yet — install from the cloned repository:

```sh
npm install -g .                # from the cloned repo; or `npm link` for development
```

```sh
cd your-project
jh init --goal "Add a greeting to the CLI without changing dependencies"
jh status                       # mode: shadow (from default)
jh constraints add "Never add new dependencies to this project"
jh check shell -- npm install left-pad     # explicit check; needs a provider
```

For live judgments set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` (keys live in
the environment, never in state files). For offline runs and tests, point
`--replay <file>` (or `JH_REPLAY`) at a synthetic answer script — see any
`examples/*/replay.json`.

### Claude Code

```sh
jh install claude               # default scope: local (.claude/settings.local.json)
jh install claude --print       # inspect the settings fragment without writing
jh hooks claude                 # verify what is installed
jh mode enforce                 # opt in to blocking (default is shadow)
jh uninstall claude             # rollback: removes only our entries, keeps a .jev.bak
```

The installer merges idempotently, preserves unrelated hooks and keys, refuses
malformed settings files, and writes atomically with a backup. Installed hooks
call `jh hook claude`, which maps Claude's six hook events onto the gates.
Details and honest limits: [docs/claude-code.md](docs/claude-code.md).

### Pi

The package exposes a Pi extension (`jev-harness/pi`, declared in
`package.json`'s `pi.extensions`). Install the package into Pi, keep
`JH_MODE` unset for shadow or set it to `enforce` to opt in (it overrides
`.harness/config.json`; `JEV_HARNESS_MODE` is a deprecated alias), and
initialize each project with `jh init` first — uninitialized projects are inert.
The exact seam is documented in [docs/pi.md](docs/pi.md).

## What is covered — and what is not

| Capability | Status | Automatic or explicit | Advisory or blocking |
| --- | --- | --- | --- |
| G1 shell command effect | implemented | automatic via Claude `PreToolUse`; explicit `jh check shell` | blocking in enforce |
| G2 secret-bearing writes | implemented | automatic via `PreToolUse`; explicit `jh check write` | blocking in enforce |
| G3 tool-result screening | implemented | automatic via `PostToolUse` | **advisory only** in Claude Code (built-in output cannot be replaced) |
| G4 standing-rule capture | implemented | automatic via `UserPromptSubmit`; explicit `jh constraints add` | recorded verbatim |
| G5 correction freeze | implemented | automatic; released only by a new accepted request | blocking in enforce; **never cleared by `Stop`** |
| G6 plan/goal relation | implemented | automatic on every shell/write/edit | blocking in enforce |
| G7 attempt dedup | implemented | explicit `jh attempts register` | blocking on repeats |
| G8 claim vs. observed evidence | implemented | explicit `jh check claim` | blocking in enforce |
| G9/G10 compaction drift/fidelity | implemented | explicit `jh compact validate`; host compaction seams | blocking in enforce |
| Observed evidence | implemented | explicit `jh evidence observe` (executes and observes) | caller-supplied "source/result" claims are **not** evidence |
| Git commits, final answers, arbitrary shell side effects | **not intercepted** | — | use the explicit commands above |

More detail: [docs/gates.md](docs/gates.md), [docs/security.md](docs/security.md),
[docs/architecture.md](docs/architecture.md), [docs/compaction.md](docs/compaction.md).

## Honest limits

- **Hooks are not a sandbox.** A crashed, timed-out, or disabled hook lets the
  action proceed. Keep the host's own permissions and OS-level isolation in place.
- **Shadow is the default everywhere.** Nothing blocks until `jh mode enforce`
  (or `JH_MODE`/`JEV_HARNESS_MODE`) is set for an initialized project.
- **Unavailable is never an approval.** In enforce mode, a missing API key,
  corrupt state, or failed audit write escalates to the owner instead of allowing.
- **Rollback is trivial.** `jh uninstall claude` removes the hooks;
  `jh mode shadow` stops enforcement; deleting `.harness/` removes all state.
  Committed state files (`goal.md`, `constraints.md`, `attempts.jsonl`,
  `summary.json`) are plain text you can review and edit; `runtime/` and
  `audit/` are git-ignored.
- **No measured live accuracy.** The eval fixtures are labels for offline
  contract tests. Do not read them as calibration.

## Development

```sh
npm run check       # typecheck + build + offline tests
just pack           # inspect the npm package contents
```

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). License: MIT.
