import type { StateService, StateSnapshot } from "../contracts.js";
export interface InitializedProject {
    readonly directory: string;
    readonly state: StateSnapshot;
}
/** Explicit owner operation: never called by event preflight or by project import. */
export declare function initializeProject(projectRoot: string, goal: string): Promise<InitializedProject>;
/** null only for fully absent `.harness/`; missing files in an existing dir are corruption. */
export declare function readProject(projectRoot: string): Promise<StateSnapshot | null>;
/** Avoid following aliases to a protected harness file or outside the trusted root. */
export declare function classifyWritePath(projectRoot: string, requested: string): Promise<"protected" | "outside" | "ordinary">;
export declare function canSendFileToJev(projectRoot: string, requested: string): Promise<boolean>;
export declare function createFileStateService(): StateService;
