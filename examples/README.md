# Offline examples

Four runnable, synthetic, offline examples. Each spins up a temporary project,
drives the real harness and Claude dispatcher with a **replay script** of
synthetic answers (`replay.json`), and prints the decisions. They prove the
wiring and thresholds — never live Jev judgment. No API key, no network.

```sh
node examples/no-new-dependencies/run.mjs
node examples/stop-and-explain/run.mjs
node examples/policy-survives-compaction/run.mjs
node examples/claim-observed-tests-only/run.mjs
```

Or through the CLI: `jh example list` and `jh example run <name>`.

Each example's committed `expected.txt` is the exact output; run any example
with `--check` to verify (`jh example run <name> --check` does the same).
Random ids and dates in the output are masked for determinism.

| Example | Shows |
| --- | --- |
| `no-new-dependencies` | an owner rule is captured verbatim, then `npm install` is denied while a harmless command passes |
| `stop-and-explain` | a correction freezes all tool use; `Stop` never clears it; only a new accepted request does |
| `policy-survives-compaction` | a public-API constraint is re-injected by `SessionStart` after compaction (PreCompact stdout cannot reach the native summary) and still blocks a breaking edit |
| `claim-observed-tests-only` | a "tests pass" claim is blocked until the harness itself executes and observes the test run; only a trusted embedding with a pre-declared expectation may attach a result — the CLI cannot |
