# Compaction validation and acknowledgment

Compaction is the moment an agent's context is replaced by a summary. This package
**audits** that transition; it never produces a summary, never rewrites the agent's
`noteToSelf`, and never infers typed facts from prose. Summary production stays with
the host (Pi's `self-compact`, Claude Code's native compaction, or an explicit CLI
candidate). Code declarations in [`src/core/contracts.ts`](../src/core/contracts.ts)
are authoritative.

## Lifecycle

```ts
const { decision, retainedPolicyBlock } = await harness.validateCompaction({
  context, summaryText, noteToSelf, checkpoint, reason,
});
// …host applies the candidate only if the decision allows it…
await harness.acknowledgeCompaction({ context, compactionId, validationId: decision.validationId, succeeded: true });
```

1. **Validate before apply.** `validateCompaction` runs gate **G9 (drift)** and
   **G10 (fidelity)** in one batched provider call against the *actual* candidate
   bytes. The candidate event is never mutated.
2. **Apply or reject in the host.** The harness returns a decision; the adapter
   cancels or proceeds using the host's own mechanism.
3. **Acknowledge after success.** `acknowledgeCompaction` is called only once the
   host confirms the compaction actually happened, using the host's **persisted**
   compaction identity. Failed or aborted cycles are never acknowledged.

## What the gates judge

- **G9 `g9-drift`** — candidate prose/note *and* the typed checkpoint vs. the
  canonical goal, standing constraints, and preserved decisions. It judges whether
  the candidate rewrites the owner's goal, how its next action relates to the goal
  (`direct` / `supporting` / `detour` / `other` / `none`), whether a detour has a
  credible path back, and a 0–4 drift score. Outcomes: `block` (goal rewrite,
  dropped/contradicted constraint, reversed preserved decision), `replan` (drift
  score ≥ 3, or a detour with no path back), `remind` (drift score ≥ 2),
  `escalate` (uncertain), `allow`.
- **G10 `g10-fidelity`** — candidate vs. recorded attempts and observed evidence
  (most recent 25 of each). Outcomes: `block` (contradicts recorded evidence, or
  asserts unobserved results as fact with high confidence), `remind` (unsupported
  wording that should stay tentative), `escalate` (uncertain), `allow`.

All numeric thresholds live beside each gate (`thresholds`), never in a prompt.
Deterministic checks run before any provider call: empty candidates, credentials in
the candidate, and schema-invalid checkpoints are rejected without contacting Jev.

Gates are batched into as few provider calls as fit the redaction budget,
packed deterministically in gate order. A candidate too large to judge whole
fails `unavailable` — a compaction is never approved on truncated data, and
cancellation is honored before each request and before every registry write.

## Decision semantics

- **Policy hold** — `status: "ready"` with `block`/`replan`: the candidate is
  rejected. Do **not** rerun summarization or switch backends to shop for approval.
- **Retryable failure** — `status: "unavailable"`: provider, registry, state, or
  audit failure. Enforcement escalates; shadow only observes.
- **Acceptable** — `status: "ready"` with `allow` or `remind`. In **enforce** mode
  the decision carries a `validationId` (`v-…`); persist it with the compaction.
  In **shadow** mode no id is issued and nothing is written. Shadow returns the
  strongest **proposed** verdict across the gates, never the first gate's allow.
- **Stagnation hold** — with `evidenceWorkflow: true` only, an acceptable
  candidate is overlaid with `replan` (gateId `evidence-stagnation`) once 2
  trailing successful cycles passed without new confirmed/refuted evidence, and
  with `halt` at 3. The `replan` still carries a `validationId` so a
  host-confirmed success acknowledges and counts (keeping the halt reachable);
  the `halt` issues none. `decision.stagnantCycles` reports the count.

## The retained policy block

`retainedPolicyBlock` (also exported as `buildRetainedPolicyBlock(state)`) is a
deterministic rendering of the canonical goal, every standing constraint, and
preserved key decisions. It is delivered **separately** in the next model context —
never merged into or used to replace the summary or note. The same state always
produces the same block.

## Validation/ack registry

Each accepted validation is recorded durably in the project's ignored
`.harness/runtime/compactions.jsonl` (append-only, locked, fsynced; inject
`HarnessServices.compactionRegistry` to override, e.g.
`createMemoryCompactionRegistry()` for tests). The record binds:

- host, project, session, and request (hashed),
- the harness **mode**,
- the **state revision** the candidate was judged against,
- a hash of the exact candidate bytes (`compactionCandidateHash`) — prose is never
  stored.

Authentication happens **before** any idempotent success: a `compactionId`
already present in project state never bypasses registry provenance.
`acknowledgeCompaction` rejects, with `escalate`:

- **forged** — unknown `validationId` (no successful validation preceded it),
  even when the `compactionId` was already acknowledged under another id,
- **mismatched** — different project, session, request, or mode,
- **wrong candidate** — a supplied `candidateHash` that differs from the recorded
  candidate hash, or a `checkpoint` that was not part of the validated candidate,
- **stale** — project state changed after validation (re-validate instead),
- **consumed** — the same `validationId` presented with a different `compactionId`,
- **reused** — a `compactionId` already bound to a **different** `validationId`
  (registry reverse binding; holds with and without the evidence workflow).

Acknowledgment is **idempotent**: repeating the same `(validationId, compactionId)`
returns action `none` and never double-counts. The ack decision is **audited
before** any registry or state mutation (a failed audit publishes nothing), and
the registry ack is persisted before state moves.

State application is a **single atomic compare-and-swap mutation** (one
`summary.json` replacement) that writes the stagnation counter/cycle (evidence
workflow only), the merged validated checkpoint, and the durable application
marker `checkpointAcks: [validationId]` together. Retry recovery after a crash
between the registry ack and the state apply is exact:

- Marker already recorded → the replay is a pure no-op, even on newer state; a
  fully applied historical ack never republishes its checkpoint.
- Marker absent and the project state revision still equals the validated
  revision → the retry applies the mutation (exactly-once recovery).
- Marker absent and any unrelated write intervened → fail-closed `escalate`
  ("stale"); the stale checkpoint is never merged into newer state and the
  candidate must be re-validated.

A corrupt or oversized registry fails closed (`unavailable`) rather than being
guessed around.

## Checkpoint persistence

A validated typed checkpoint is bound to the registry record by hash
(`checkpointHash`); the checkpoint itself is never stored in the registry. To
persist it, the adapter resends the exact validated `checkpoint` on the ack. Only
a hash-matching checkpoint is written to project state, and prior key decisions
and rules it does not contain are preserved deterministically (validated entries
first, then the missing prior entries in their original order). Nothing is ever
invented from prose, and an absent checkpoint is audited as absent.

## Stagnation counters are opt-in

The durable compaction counter (`state.compactionIds` plus per-cycle
target-evidence marks in `state.compactionCycles`) advances **only** when the
harness is created with `{ evidenceWorkflow: true }` — the explicit
experiment/evidence workflow. Ordinary projects leave it off: acknowledgments are
still validated, deduplicated, and audited, but counters never move.

Each acknowledged cycle is bound to the **target-evidence mark** at ack time (a
hash of the confirmed/refuted evidence ids), so stagnation identity survives
reload. `stagnantCycles(state)` counts the trailing cycles whose mark still
equals the current one; new confirmed/refuted evidence resets it exactly once.
Inconclusive observations, setup failures, and retries never move the mark or
the count, cycles recorded before mark tracking (`evidence: null`) never count,
and two distinct cycles with byte-identical prose each get their own
`validationId` and count once each. The policy hold is defined at **validation
of the next candidate** from prior successful cycles — never by rejecting
acknowledgments — so counting can reach the halt threshold.

## Host seams

- **Pi:** the existing `self-compact` extension owns the summary, the note, and
  native overflow recovery. Add one optional awaited validation/finalizer seam that
  covers both the selective and generative backends; catch enforced validation
  failures inside the seam (Pi's event runner swallows handler exceptions). Resolve
  the **latest** persisted compaction entry on the active branch for
  `compactionId` — an older entry with identical summary text is not the new cycle.
- **Claude Code:** `PreCompact` cannot see the not-yet-generated native summary.
  Validate explicit candidates only, and restore the canonical policy block at
  `SessionStart` (including `compact`) instead of claiming to rewrite the native
  summary.

See [`docs/architecture.md`](architecture.md) for the shared event contracts and
[`eval/g9-drift.jsonl`](../eval/g9-drift.jsonl) /
[`eval/g10-fidelity.jsonl`](../eval/g10-fidelity.jsonl) for labelled synthetic
judgment fixtures (contract examples, not live accuracy measurements).
