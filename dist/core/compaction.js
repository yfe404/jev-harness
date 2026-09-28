import { digest } from "./report.js";
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
}
/** Stable identity of the exact candidate under audit: summary prose, the
 * unmodified note, and any agent-authored checkpoint. Never stores the prose. */
export function compactionCandidateHash(event) {
    return digest(canonical({ summaryText: event.summaryText, noteToSelf: event.noteToSelf ?? null, checkpoint: event.checkpoint ?? null }));
}
/** Stable identity of a validated typed checkpoint alone (safe known data). */
export function checkpointHash(checkpoint) {
    return digest(canonical(checkpoint));
}
/** Evidence-stagnation thresholds: replan at 2 trailing evidence-free cycles,
 * halt at 3. Only the explicit evidence workflow applies them. */
export const STAGNATION_REPLAN = 2;
export const STAGNATION_HALT = 3;
/** Mark of the current target evidence: the sorted ids of harness-observed
 * (source "harness") observations carrying a confirmed/refuted result — the only
 * credible trial outcomes; arbitrary tool-source text never carries a result.
 * Inconclusive evidence and setup failures never move the mark; a new credible
 * confirmed/refuted observation resets stagnation once. */
export function targetEvidenceMark(state) {
    const ids = state.evidence
        .filter(e => e.source === "harness" && (e.result === "confirmed" || e.result === "refuted"))
        .map(e => e.id).sort();
    return digest(ids.join("\n"));
}
/** Trailing successful unique cycles acknowledged without any new confirmed or
 * refuted target evidence since. Cycles recorded before cycle tracking (null
 * mark) never count. */
export function stagnantCycles(state) {
    const cycles = state.compactionCycles ?? state.compactionIds.map(id => ({ id, evidence: null }));
    const mark = targetEvidenceMark(state);
    let count = 0;
    for (let index = cycles.length - 1; index >= 0; index--) {
        if (cycles[index].evidence !== mark)
            break;
        count++;
    }
    return count;
}
/** Merge a newly validated checkpoint with the prior one deterministically:
 * the validated checkpoint wins, and prior key decisions/rules it does not
 * already contain are preserved in their original order. Nothing is invented. */
export function mergeCheckpoint(validated, prior) {
    if (!prior)
        return validated;
    return {
        ...validated,
        rules: [...validated.rules, ...prior.rules.filter(rule => !validated.rules.includes(rule))],
        keyDecisions: [...validated.keyDecisions, ...prior.keyDecisions.filter(decision => !validated.keyDecisions.includes(decision))],
    };
}
/** Structural identity used to detect an already-persisted merged checkpoint. */
export function sameCheckpoint(a, b) {
    if (a === null || b === null)
        return a === b;
    return canonical(a) === canonical(b);
}
/** Canonical owner-authored policy, restored separately from the candidate.
 * Deterministic: same state always yields the same block, and the agent's note
 * or summary is never edited to include it. */
export function buildRetainedPolicyBlock(state) {
    const lines = [
        "[jev-harness canonical policy — authoritative over any compaction summary]",
        `Goal: ${state.goal.trim()}`,
    ];
    if (state.constraints.length) {
        lines.push("Standing constraints:");
        for (const rule of state.constraints)
            lines.push(`- ${rule.id} (${rule.createdAt}): ${rule.text}`);
    }
    const decisions = state.summary?.keyDecisions ?? [];
    if (decisions.length) {
        lines.push("Preserved decisions:");
        for (const decision of decisions)
            lines.push(`- ${decision}`);
    }
    return lines.join("\n");
}
