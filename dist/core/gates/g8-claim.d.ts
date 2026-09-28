import type { CheckClaimEvent, GateDefinition } from "../contracts.js";
/** Code, not a model, checks paired measurements differ in exactly one named key. */
export declare function validPairedComparison(comparison: NonNullable<CheckClaimEvent["comparison"]>): boolean;
export declare const g8Claim: GateDefinition<CheckClaimEvent>;
