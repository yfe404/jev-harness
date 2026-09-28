# Architecture and shared contracts

This page freezes the interfaces for the core, Claude Code hooks, Pi extension, and CLI. Code declarations in [`src/core/contracts.ts`](../src/core/contracts.ts) are authoritative. Core gates G1–G8 are implemented; the CLI and Pi entries remain bootstrap placeholders until their adapter turns. An unavailable gate is **not** an approval.

## The boundary

A host adapter authenticates the source of a user message, checks project trust, normalizes events, and translates actions back into that host's supported hook contract. It never decides a gate's threshold. `createHarness(services, options)` owns gating and calls injected services; it never requires a host runtime at import time. No module imports paths from a private host project. Gate files own their questions, numeric thresholds, and pure evaluation functions.

Jev supplies bounded answers. Code validates *all* answers against the questions, then decides what action to propose. A Choice question includes `none` or `other`; noul probability is in `[0, 1]`, and choice/score require explicit confidence and labelled probabilities. Never infer a missing confidence or map a missing answer to permission. Numeric thresholds belong beside each gate, not in Jev instructions.

Default mode for an initialized project is `shadow`: audit a **proposed** verdict but apply `allow`. An uninitialized or untrusted project is `inert` and must make no provider call or create state. Explicit enforcement must escalate when Jev, state, or audit is unavailable. `escalate` means stop the requested action and ask the owner; an adapter with no interactive UI must return a blocking reason. Audit the verdict **before** applying it. Missing or malformed provider answers produce an `unavailable` decision rather than a guessed approval. Compaction G9/G10 remains unavailable until its assigned integration is installed.

## Repository-local state

Initialization creates `.harness/goal.md`, `constraints.md`, `attempts.jsonl`, and `summary.json` in the **user's project**, not in this package. Those four files are durable and intended for review and version control. Neither the agent nor Jev writes `goal.md`; the owner defines the outcome and success test. The harness captures authenticated standing user instructions verbatim in `constraints.md`, with an id/date. If wording contains a secret, pause for the owner to provide a safe equivalent; do not persist or transmit the raw secret. The harness validates attempts/evidence and appends to `attempts.jsonl`. The agent may propose an optional typed checkpoint, which the harness validates before committing `summary.json`. Lack of a checkpoint remains lack of a checkpoint; do not backfill inferred facts from prose.

`.harness/runtime/` and `.harness/audit/` hold ignored session-scoped locks and verdict logs. Never commit either directory. State writes require compare-and-swap revision checks and cross-process serialization; a failed write must not silently downgrade enforcement. A new attempt starts inconclusive and does not count as a trial. A result needs matching observed harness evidence; setup failures do not count. Only a host adapter that witnessed tool or harness data should call `recordEvidence`. Keep credentials, raw external outputs, and private project context out of examples, fixtures, and the public repository. Hash identifiers and sanitize outbound state and audit entries. A redaction filter is not a sandbox or a guarantee that arbitrary secrets cannot leave the machine.

## Normalized events and entrypoints

All entrypoints use an `EventContext { host, projectRoot, sessionId, requestId, trusted }` established by the adapter. `requestId` covers a complete user request, including its tool/model subturns. Do not clear a stop/correction freeze at Pi's `turn_end` (which can occur repeatedly during one request). Extension-injected messages are not authenticated user instructions.

```ts
import { createHarness, type HarnessServices, type HarnessOptions } from "jev-harness";

const harness = createHarness(services, { mode: "shadow" });
await harness.onUserInput(event);               // Promise<Decision>
await harness.onToolPreflight(event);            // Promise<Decision>
await harness.onToolResult(event);               // Promise<ToolResultDecision>
await harness.registerAttempt(event);            // Promise<Decision>
await harness.recordEvidence(event);             // Promise<Decision>
await harness.checkClaim(event);                 // Promise<Decision>
await harness.validateCompaction(event);        // Promise<CompactionDecision>
await harness.acknowledgeCompaction(event);      // Promise<Decision>
```

`ToolResultDecision.replacement` is optional: an adapter only supplies it when the host can replace the actual output. A Claude Code `PostToolUse` advisory message must never be described as replacing or sanitizing the result Claude has already received. Run deterministic hard stops before calling the decision provider and keep the host's own permissions/sandbox in place.

A `Decision` includes `gateId`, `mode`, `proposedAction`, `appliedAction`, `status`, `reason`, `probabilities`, and an optional authorized alternative. Successful explicit state registration also returns `recordedId` (constraint, attempt, or evidence); capped dedup returns `coverage { checked, total, complete }`. In `shadow`, `proposedAction` records what enforcement *would* do; `appliedAction` remains `allow` or `none`. Status distinguishes `ready`, `inert`, `unavailable`, and `escalation`. Audit records contain a state hash and hashed session/request identifiers, validated probabilities, actions, and latency; no raw prompts or command bodies. An unavailable result in enforce mode applies `escalate`, not `allow`.

`GateDefinition<Input>` has `prepare(input, state): GateQuery | null` and `evaluate(input, answers, state): GateVerdict`. Its `thresholds` are readonly numbers. The dispatcher batches compatible questions triggered by the same event into one provider call while preserving each gate's evaluator and logged verdict. Experiment comparison has a 255-entry cap and at most eight concurrent requests. Partial coverage is marked on the decision and requires owner review in enforcement mode. `runBatchedGates` and `replayVerdict` support deterministic offline fixtures.

`HarnessServices` injects a `DecisionProvider.decide(request, signal?)`, a `StateService.read(context)` and compare-and-swap `write(context, expectedRevision, mutation)`, an `AuditService.append(entry)`, optional `RuntimeService` request/session locks, and an optional clock. For file-backed integration use `createJevClient`, `createFileStateService`, `createFileRuntimeService`, and `createFileAuditService(context)`. Adapters must clear a correction lock only after its corrective request settles (or an explicit owner reset), not at every tool/model turn. Concurrent requests in the same session remain frozen until then. The provider returns untrusted JSON; call `validateAnswers(questions, payload)` before any evaluator. Fixtures in `test/support/fixtures.mjs` provide in-memory versions. The TypeSafe System One and OpenRouter Decisions transports share this contract; API keys live in the local environment, never in state files.

## Compaction ownership

`validateCompaction({ summaryText, noteToSelf?, checkpoint?, reason, context })` receives the **actual** candidate prose or agent-saved handoff. It returns `CompactionDecision { decision, retainedPolicyBlock }`. A typed checkpoint is optional and must be agent-authored. The G9/G10 validator (implemented in the compaction integration turn) may warn, block, or request replanning; it must never generate summary prose or alter `noteToSelf`. Until that validator and its acknowledgment registry are wired, enforcement escalates instead of counting a compaction. The policy block contains canonical owner-authored constraints and preserved decisions and is delivered **separately** in the next model context. `acknowledgeCompaction({ compactionId, validationId, succeeded: true, context })` is called only after host confirmation of a successful, unique compaction; failed/aborted cycles do not increment stagnation counters.

For Pi, the existing `self-compact` extension owns the compaction result, the handoff note, and native overflow recovery. Add one optional awaited validation seam; never register a competing `session_before_compact` summary producer. For Claude Code, `PreCompact` cannot inspect the summary that has not been generated yet; validate an explicit candidate and restore canonical policy at the supported post-compact/session-start seam instead of claiming to rewrite its native summary.

## Package and ownership

This is an independent Git repository. Private host projects can pin it as a submodule; the public package has no dependency on their directory structure. The package is ESM for Node 24+, built with a pinned development TypeScript dependency; committed `dist/` JavaScript and declarations are the runtime source for both the `jh` CLI and Pi's `pi.extensions` package manifest. `npm install --omit=dev` and `pi install /path/to/jev-harness` therefore need no compiler and no AGI checkout. The package exports `jev-harness`, `jev-harness/core/contracts`, and `jev-harness/pi` (entry paths are in `package.json`). CI checks that committed `dist/` matches source. Git installs must not run a build in a production-only `prepare` hook.

File ownership during implementation: Sol owns `package.json`, lockfile, build configuration, `src/index.ts`, `src/core/contracts.ts`, `docs/architecture.md`, CI, and eventually core gates G1–G8 and state/client/runtime. Drift owns `src/cli.ts`, `src/adapters/claude-code/`, the public README, examples, and Claude docs. Fable owns `src/adapters/pi/`, G9/G10, compaction helpers, and the AGI-only bridge. The CLI and Pi entries in this bootstrap are explicit placeholders to be replaced by their owners. Offline mock tests establish contracts, not live gate accuracy. Run live evaluation and shadow observation before enabling enforcement. Other builders can import the frozen contracts and fixture services without editing package configuration.
