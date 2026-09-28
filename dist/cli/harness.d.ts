import type { EventContext, Harness, Host, Mode } from "../core/contracts.js";
export interface Wiring {
    readonly root: string;
    readonly mode: Mode;
    readonly context: EventContext;
    readonly harness: Harness;
    /** "replay" when an offline script drives the provider, "live" otherwise. */
    readonly providerKind: "replay" | "live";
}
export interface WireOptions {
    readonly root: string;
    readonly host: Host;
    readonly sessionId?: string;
    readonly requestId?: string;
    /** Explicit replay script path; JH_REPLAY is the environment equivalent. */
    readonly replay?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
}
export declare function wireHarness(options: WireOptions): Promise<Wiring>;
