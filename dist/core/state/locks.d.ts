import type { EventContext, RuntimeService } from "../contracts.js";
export interface RequestState {
    readonly frozen: boolean;
    readonly planReviewed: boolean;
}
export interface AcceptedRequestState {
    readonly fresh: boolean;
    readonly releasedPriorFreeze: boolean;
}
export declare function getRequestState(ctx: EventContext): Promise<RequestState>;
/** Record host acceptance before invoking onUserInput. A retried request cannot release a later freeze. */
export declare function acceptNewUserRequest(ctx: EventContext): Promise<AcceptedRequestState>;
/** Freeze this request; an older retry cannot resurrect a superseded correction. */
export declare function freezeRequest(ctx: EventContext): Promise<void>;
/** Explicit owner reset only; never call from Stop, turn_end, settlement or queued input. */
export declare function clearRequestFreeze(ctx: EventContext): Promise<void>;
export declare function markPlanReviewed(ctx: EventContext): Promise<void>;
export declare function createFileRuntimeService(): RuntimeService;
