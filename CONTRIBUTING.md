# Contributing

Thanks for helping. This repository is an independent public package; keep it
free of private host-project paths, credentials, and unverifiable claims.

## Ground rules

- **Node 24+, zero runtime dependencies.** The package is ESM TypeScript built
  with the pinned dev TypeScript. Committed `dist/` is the runtime; rebuild it
  with `npm run build` and keep it in sync with `src/` (CI checks this).
- **Offline tests only.** `npm run check` must pass without network access or
  API keys. Contract tests use in-memory fixture services
  (`test/support/fixtures.mjs`) and synthetic replay scripts; they prove wiring
  and thresholds, never live Jev judgment. Do not commit recorded live traffic.
- **No secrets, ever.** Fixtures, examples, docs, and audit/state files must
  not contain credentials, private workstation paths, or real user data. The
  redaction helpers are a filter, not a guarantee — review what you commit.
- **Thresholds are code.** Numeric decisions live in each gate's `thresholds`,
  never in a Jev prompt. Prompts describe judgments; code decides actions.
- **Fail closed in enforce, fail observable in shadow.** An unavailable
  provider, state, registry, or audit write must escalate (enforce) or be
  logged as a proposal (shadow) — never silently allow.
- **Observed evidence only.** `recordEvidence` is for data the harness or a
  host tool actually observed. Never let a caller's `source`/`result` fields
  impersonate harness-observed evidence, and never add a CLI flag that
  attaches a trial result — the CLI records observations only; grading belongs
  to trusted embeddings of the core API with owner-configured expectations.

## Repository layout

- `src/core/` — contracts, gates G1–G10, state/audit/runtime services, Jev client
- `src/adapters/claude-code/` — Claude hook dispatcher, session correlation, settings installer
- `src/adapters/pi/` — Pi extension entry and injectable seam
- `src/cli.ts`, `src/cli/` — the `jh` CLI (config, replay provider, commands)
- `examples/` — four runnable offline examples with committed expected output
- `eval/` — labelled synthetic fixtures (offline contract data, not calibration)
- `test/` — `node --test` suites mirroring the source layout

## Making changes

1. `npm ci && npm run check` — establish a green baseline.
2. Keep public contracts in `src/core/contracts.ts` additive; adapters and the
   CLI depend on them. Coordinate changes that cross ownership boundaries.
3. Add or update offline tests for every behavior change. Run examples with
   `--check` if you touch the CLI, dispatcher, gates, or replay provider:
   `for e in examples/*/; do node "$e/run.mjs" --check; done`
4. `npm run build` and confirm `git diff --check` is clean. Run
   `npm run smoke` (pack + isolated install) when you touch `package.json`,
   the CLI entry, or `examples/`.
5. Describe behavior truthfully in docs: distinguish implemented vs. planned,
   automatic vs. explicit, advisory vs. blocking, and offline-tested vs.
   live-evaluated.

## What not to do

- Don't add runtime dependencies without discussion.
- Don't weaken the privacy guards (path classification, redaction, state
  validation) to make a test pass.
- Don't claim measured accuracy, speed, or cost numbers in docs or examples.
- Don't clear correction freezes from lifecycle events (`Stop`, `turn_end`,
  settlement); only a new accepted user request or an explicit owner reset may.
- Don't emit `permissionDecision: "allow"` from Claude hooks; pass-through is
  exit 0 with empty stdout. Error paths that must block use exit 2; a bare
  exit 1 is non-blocking per the official hook contract.
- Don't print guidance from a `PreCompact` hook and call it protection — its
  stdout does not reach Claude or the native summary. Policy restoration
  belongs to `SessionStart`.
