import type { DecisionProvider } from "../core/contracts.js";
/**
 * Offline provider for examples and tests. It answers from a script of synthetic replies,
 * so it proves the wiring and thresholds, never Jev's judgment.
 *
 * {
 *   "replies": [
 *     { "gate": "g6-plan", "when": "left-pad", "answers": { "violates": { "matching": "dependencies" }, "relation_to_goal": "direct" } },
 *     { "gate": "g6-plan", "answers": { "violates": "none", "relation_to_goal": "direct" } }
 *   ]
 * }
 *
 * The first reply whose `gate` matches and whose `when` text (or every entry of a `when` array)
 * appears in that gate's request state, case-insensitively, is used. Shorthand answers:
 * - noul: a probability, e.g. `0.9`
 * - choice: a label, `{ "matching": "text in the option description" }`, or `{ "label": "x", "p": 0.8 }`
 * - score: a level index, e.g. `2`
 * Full System One answer objects are passed through unchanged.
 */
export interface ReplayRule {
    readonly gate: string;
    readonly when?: string | readonly string[];
    readonly answers: Readonly<Record<string, unknown>>;
}
export declare function loadReplayRules(path: string): readonly ReplayRule[];
export declare function createReplayProvider(rules: readonly ReplayRule[]): DecisionProvider;
