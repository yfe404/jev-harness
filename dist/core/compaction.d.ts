import type { CompactionValidationEvent, StateSnapshot, TypedCheckpoint } from "./contracts.js";
/** Stable identity of the exact candidate under audit: summary prose, the
 * unmodified note, and any agent-authored checkpoint. Never stores the prose. */
export declare function compactionCandidateHash(event: Pick<CompactionValidationEvent, "summaryText" | "noteToSelf" | "checkpoint">): string;
/** Stable identity of a validated typed checkpoint alone (safe known data). */
export declare function checkpointHash(checkpoint: TypedCheckpoint): string;
/** Evidence-stagnation thresholds: replan at 2 trailing evidence-free cycles,
 * halt at 3. Only the explicit evidence workflow applies them. */
export declare const STAGNATION_REPLAN = 2;
export declare const STAGNATION_HALT = 3;
/** Mark of the current target evidence: the sorted ids of harness-observed
 * (source "harness") observations carrying a confirmed/refuted result — the only
 * credible trial outcomes; arbitrary tool-source text never carries a result.
 * Inconclusive evidence and setup failures never move the mark; a new credible
 * confirmed/refuted observation resets stagnation once. */
export declare function targetEvidenceMark(state: Pick<StateSnapshot, "evidence">): string;
/** Trailing successful unique cycles acknowledged without any new confirmed or
 * refuted target evidence since. Cycles recorded before cycle tracking (null
 * mark) never count. */
export declare function stagnantCycles(state: Pick<StateSnapshot, "compactionIds" | "compactionCycles" | "evidence">): number;
/** Merge a newly validated checkpoint with the prior one deterministically:
 * the validated checkpoint wins, and prior key decisions/rules it does not
 * already contain are preserved in their original order. Nothing is invented. */
export declare function mergeCheckpoint(validated: TypedCheckpoint, prior: TypedCheckpoint | null): TypedCheckpoint;
/** Structural identity used to detect an already-persisted merged checkpoint. */
export declare function sameCheckpoint(a: TypedCheckpoint | null, b: TypedCheckpoint | null): boolean;
/** Canonical owner-authored policy, restored separately from the candidate.
 * Deterministic: same state always yields the same block, and the agent's note
 * or summary is never edited to include it. */
export declare function buildRetainedPolicyBlock(state: StateSnapshot): string;
