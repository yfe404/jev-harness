# Pi adapter

Use jev-harness inside [Pi](https://github.com/earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent` 0.85.x). The adapter is a Pi extension that maps Pi's extension events onto the audited harness gates: tool preflights, result screening, user-correction freezes, canonical policy restoration, and validated compaction acknowledgment.

The public package has **no runtime dependency on Pi**. It describes Pi's extension surface structurally, so it loads under Pi and can be driven offline by any compatible host.

## Install

Build the package, then install it into Pi by absolute path (per Pi's package rules a directory is loaded using its `package.json`, which declares `"pi": { "extensions": ["./dist/adapters/pi/index.js"] }`):

```bash
cd vendor/jev-harness        # the cloned repository
npm ci && npm run build      # produces dist/
pi install /absolute/path/to/cloned/jev-harness
```

`pi install` writes to your user settings by default; use `pi install -l /absolute/path` for project settings. Remove with `pi remove /absolute/path/to/cloned/jev-harness`.

The extension factory is inert on load: no provider traffic, no file access, no state mutation until a session actually starts in a trusted, explicitly initialized project. Model-catalog probes and discovery loads never touch your project or your API key.

## Initialize a project

Uninitialized projects stay inert — the adapter observes nothing and changes nothing. Initialize with the CLI first:

```bash
jh init --goal "Add a greeting to the CLI without changing dependencies"
```

This creates `.harness/` (goal, constraints, state) which is also what the CLI uses; the Pi adapter and the `jh` CLI share the same on-disk project.

## Mode: shadow by default, enforce by explicit opt-in

Mode resolution mirrors the CLI, per session, at the nearest directory holding a real `.harness/` (the walk starts at the session cwd, so a nested cwd adopts the ancestor project):

1. `JH_MODE=shadow|enforce` (environment) wins. `JEV_HARNESS_MODE` still works as a deprecated alias.
2. Otherwise `.harness/config.json`: `{ "mode": "enforce" }`.
3. Otherwise `shadow`.

- **shadow** (default): every gate still runs and is audited, but the adapter never blocks a tool, never prompts, never injects hold semantics, and never freezes — including when a freeze was persisted by another (enforce) session. Claim verdicts are honest in shadow: an applied `allow` never reads as "supported".
- **enforce**: gates are applied. Blocking requires an explicitly initialized, trusted project; ambiguous or broken setups fail closed, never open:
  - a corrupt `.harness/config.json` (bad JSON, unknown keys, invalid mode) resolves to a blocking enforce hold, never to the silent default shadow;
  - unreadable/corrupt initialized state blocks tools until repaired;
  - a symlinked `.harness` at the session directory is invalid state, not a reason to adopt an ancestor's project;
  - a harness that cannot be constructed blocks rather than degrading to inert.

Provider credentials come from the environment (`TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` for the OpenRouter transport), exactly as for the CLI. They are never read at load time, only when a gated decision actually runs.

Provider requests are bounded by a timeout: `JH_TIMEOUT_MS` (milliseconds, default `15000`, valid range `1..60000`; an out-of-range value is rejected). An explicit `timeoutMs` API option wins over the environment variable. A timed-out request fails closed — the gate resolves to unavailable/escalate in enforce — and is never retried automatically.

## What the adapter does in a session

- **Built-in tool gating.** Pi's `bash`/`read`/`grep`/`find`/`ls`/`write`/`edit` map onto harness intents and are preflighted (shell effects, write targets, plan review). A tool with an **unknown intent** (any other tool name, e.g. MCP tools) escalates and is blocked back to the agent as a tool error, in interactive and non-interactive sessions alike. There are no owner confirmation dialogs and no auto-override: every uncertain, unknown, or unavailable gate outcome is an agent-facing block. Unknown tools are never silently allowed.
- **Result screening.** `tool_result` output is screened before the model sees it; recognized credentials are withheld and injected (instruction-bearing) output is wrapped as untrusted. Screening knows a fixed set of secret shapes — a secret form it does not recognize is not detected, so treat screening as a seatbelt, not a vault.
- **Correction freezes.** A user "stop / wrong approach" freezes all tools in enforce. The freeze is released only by the next authentic, actually-delivered user request (see lifecycle below) — never by `turn_end`, `agent_end`, `agent_settled`, reload, or an extension message.
- **Canonical policy restoration.** Before every model call the `context` hook injects the authoritative policy from `.harness/` (goal, standing rules, preserved decisions) so self-compact, native/manual compaction, overflow continuation, and branch navigation can never leave the agent without current rules. If the policy exceeds the injection budget the block says so explicitly (treat omitted rules as unknown, never absent) instead of claiming complete retention.
- **Evidence ledger.** Screened-safe tool results the model actually saw unmodified are recorded as citable evidence, with the observed command/path and error status (a failed run is recorded as a failure). Withheld, private, or injected output is never recorded. Agents can cite evidence ids but can never create evidence.

## Harness tools

Three explicit tools are registered (visible in Pi's tool list, never hidden side channels):

| Tool | Purpose |
| --- | --- |
| `jev_register_attempt` | Register an experiment attempt (hypothesis + method) before running it, so repeated trials are detected. |
| `jev_check_claim` | Check a result claim against cited, harness-observed evidence ids before stating it as fact. |
| `jev_evidence` | List harness-observed evidence recorded for this project. |

These tools obey a correction freeze exactly like built-in tools; so do the self-compact recovery tools (`self_compact`, `view_context`) when composed — the compaction whitelist belongs to the compaction lock, not to a text-only correction freeze.

`/jev-harness` shows mode, trust, and recorded-policy status without an LLM turn.

## Request lifecycle (why RPC and queued input behave differently)

Pi delivers input in stages; the adapter follows the real lifecycle:

- The `input` hook fires before transforms, shortcuts, and queueing, so the fresh-request transition is **deferred to `before_agent_start`** — the point where Pi has accepted the prompt for execution. A prompt that is handled or transformed away by another extension never becomes a request and never releases a freeze.
- Authentic sources are `interactive` and `rpc` (the host authenticated both). `extension` input (`pi.sendUserMessage`) is never a request: it never releases a freeze and never discards a pending prompt. Because `sendUserMessage` always triggers a turn, a `before_agent_start` whose prompt is not the pending user prompt is not accepted either.
- Mid-stream `steer` and queued `followUp` input is classified immediately against the **current** request — a live "stop" freezes tools right away — but queued prompts never become a new accepted request and never unlock a freeze.
- If an accepted request's classification is unavailable, escalated, or throws (e.g. provider outage), enforce fails closed: the freeze is re-persisted and an in-session hold keeps tools blocked until the next successfully classified request. Input handling itself never blocks or rewrites the user's prompt.
- The accepted request identity is persisted on the branch (`appendEntry`), so reload and tree navigation restore it; navigating to a branch with no marker resets to the fallback identity. In enforce, an identity that cannot be persisted is a hold, because a reload could otherwise bind state to an abandoned request.

Known limitation: another extension that *transforms* the raw input text before `before_agent_start` changes the delivered prompt; the adapter then cannot prove the accepted prompt is the user's and fails closed (the freeze holds) rather than accepting a prompt it cannot authenticate.

## Compaction

The adapter never requires a note or checkpoint tool: native overflow recovery stays Pi's own path. Canonical policy is re-injected by the `context` hook after any compaction, so coverage for a native summary is honestly absent — **no G9/G10 validation is claimed for native summaries**, and native compactions are never acknowledged.

Acknowledgment happens only for a real, persisted, validated success:

- the actual latest persisted compaction entry on the active branch is used (Pi 0.85.1 resolves the event entry by summary text, which can alias an older identical summary);
- the entry must carry namespaced validation metadata written by the validator: `details.jevHarness.validationId` and `details.jevHarness.requestId` (the request that validated the candidate — there is no fallback to whatever request is active when the event fires);
- the candidate hash is **recomputed from the actual persisted summary** plus the preserved `noteToSelf`/`checkpoint` bytes and compared against `details.jevHarness.candidateHash` when present — a summary modified after validation while reusing its metadata is not acknowledged;
- the exact validated checkpoint (when one exists) is passed through to the core; one is never fabricated from prose;
- a held, failed, or forged acknowledgment is surfaced through the UI and `bridge.onCompactionAck`, never swallowed, so a composition wrapper can pause continuation.

### Composition contract (for wrappers such as a self-compact extension)

`createPiHarnessExtension(options)` is the injectable seam. Provide `harness` (or `createHarnessForSession(context, mode)`), plus `runtime`, `readState`, `resolveMode`, `findProjectRoot`, and a `bridge`:

```ts
bridge.currentContext?.()   // EventContext | null
bridge.harnessForSession?.() // Harness | null
bridge.mode?.()              // live per-session mode (follow it; do not cache env)
bridge.onAcceptedRequest     // a fresh authentic request was accepted (supersede saved continuations)
bridge.onCompactionAck       // every ack decision; non-ready (or a throw surfaced as unavailable) is a hold
```

A wrapper that validates compaction candidates must persist, under the compaction entry's `details.jevHarness`: `validationId`, the validating `requestId`, `candidateHash` computed with the exported `compactionCandidateHash` over `{ summaryText, noteToSelf, checkpoint }`, the exact `noteToSelf` bytes, and the exact `checkpoint` when one was validated. Enforce wrappers must require a `validationId` before accepting a candidate, and must treat a non-ready `onCompactionAck` (including the synthetic `unavailable` decision emitted when the ack throws) as a continuation hold.

## Troubleshooting

- **Every decision is `unavailable` with a reason naming `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`.** The provider key never reached the Pi process (booleans like "the variable exists somewhere" do not count — the *Pi process environment* must contain it). Export the key in the shell that launches Pi (`export TYPESAFE_API_KEY=...` or `export OPENROUTER_API_KEY=...`) and start a new Pi session. No provider request is sent while the key is missing; the failure is classified locally in under a millisecond, which is the tell.
- **Mode is resolved once per session, at `session_start`.** Switching `JH_MODE`/`.harness/config.json` applies to a new Pi session (or a full `/reload` that re-runs `session_start`), not mid-turn. The canonical context banner names the current mode explicitly; in shadow it states that observation is active and no harness tool hold applies, superseding any hold narrative left over from an earlier enforce conversation.
- **Shadow mode is not a workaround for a policy decision.** Shadow only changes what the harness itself applies; it never asks you to disable safeguards that live outside the harness (owner approvals, sandboxing, your own review). Treat a shadow "would block" observation as a real judgment to act on, not as noise.

## Honest limitations

- Screening and capture are heuristic: unknown secret shapes leak neither into evidence nor prompts, but unrecognized forms in raw output still reach the model unless another gate catches them; unknown-intent tools are escalated, not understood.
- Shadow mode is observational only; it detects, it does not protect.
- The freeze/correction model assumes Pi's documented event lifecycle; hosts that reorder or synthesize `before_agent_start` get fail-closed behavior, not bypass.
- Stagnation counters (`stagnantCycles`, replan/halt) only move when the harness is constructed with `evidenceWorkflow: true`; default compositions still validate, dedupe, and audit acknowledgments without advancing counters.

See [architecture.md](architecture.md), [compaction.md](compaction.md), [gates.md](gates.md), and [security.md](security.md) for the core semantics this adapter exposes.
