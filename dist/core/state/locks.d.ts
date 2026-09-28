import type { EventContext, RuntimeService } from "../contracts.js";
export interface RequestState {
    readonly frozen: boolean;
    readonly planReviewed: boolean;
}
export declare function getRequestState(ctx: EventContext): Promise<RequestState>;
/** A correction freezes tools for every concurrent request in this session. Only its owner can clear it. */
export declare function freezeRequest(ctx: EventContext): Promise<void>;
export declare function clearRequestFreeze(ctx: EventContext): Promise<void>;
export declare function markPlanReviewed(ctx: EventContext): Promise<void>;
export declare function createFileRuntimeService(): RuntimeService;
