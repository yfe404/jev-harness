import type { Attempt, GateDefinition, RegisterAttemptEvent } from "../contracts.js";
export interface DedupComparison {
    readonly proposed: RegisterAttemptEvent;
    readonly prior: Attempt;
}
export declare const g7Dedup: GateDefinition<DedupComparison>;
