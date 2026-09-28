import type { Decision, EventContext, Harness, Mode, RuntimeService, StateSnapshot } from "../../core/contracts.js";
import { type PiExtensionApi } from "./types.js";
export declare const ATTEMPT_TOOL = "jev_register_attempt";
export declare const CLAIM_TOOL = "jev_check_claim";
export declare const EVIDENCE_TOOL = "jev_evidence";
/** Transient custom-message type carrying the restored canonical policy. */
export declare const POLICY_MESSAGE_TYPE = "jev-harness-policy";
/** Custom entry type persisting the accepted request identity on the branch. */
export declare const REQUEST_ENTRY_TYPE = "jev-harness-request";
export interface PiHarnessBridge {
    /** Filled in by the extension: the current event context, or null when inert. */
    currentContext?: () => EventContext | null;
    /** Filled in by the extension: the harness bound to the current session. */
    harnessForSession?: () => Harness | null;
    /** Filled in by the extension: the active session mode (configured default when inert). */
    mode?: () => Mode;
    /** Called after a fresh authentic user request has been accepted by the core. */
    onAcceptedRequest?: (context: EventContext) => void;
    /** Called with every compaction acknowledgment decision; a non-ready status is a hold. */
    onCompactionAck?: (decision: Decision, context: EventContext) => void;
}
export interface PiHarnessOptions {
    /** Injected harness (tests, AGI composition wrapper). */
    readonly harness?: Harness;
    /** Per-session factory used when `harness` is not injected; receives the resolved mode. */
    readonly createHarnessForSession?: (context: EventContext, mode: Mode) => Harness;
    /** Static mode default: "shadow". Enforcement is an explicit opt-in. */
    readonly mode?: Mode;
    /** Per-session mode resolution (env/config file); defaults to `mode`. */
    readonly resolveMode?: (context: EventContext) => Promise<Mode>;
    /** Walk up to the nearest initialized project root; defaults to the cwd itself. */
    readonly findProjectRoot?: (start: string) => Promise<string | null>;
    /** Shared request-lock service; also used directly for freeze checks. */
    readonly runtime?: RuntimeService;
    /** Canonical policy read; defaults to readProject. */
    readonly readState?: (projectRoot: string) => Promise<StateSnapshot | null>;
    /** Input sources treated as authentic user requests. Default: ["interactive", "rpc"]. */
    readonly authenticSources?: readonly string[];
    /** Record harness-observed tool-result evidence (default true). */
    readonly recordEvidence?: boolean;
    /** Extension tools exempt from the unknown-intent escalation but never from
     * a correction freeze (the self-compact recovery whitelist). */
    readonly exemptTools?: readonly string[];
    /** Bound on injected policy text. */
    readonly policyCharLimit?: number;
    readonly bridge?: PiHarnessBridge;
    readonly now?: () => Date;
}
/**
 * Build the Pi extension. The returned factory registers handlers only; all
 * state/service work is deferred to session_start and later events, so model
 * catalog probes and discovery loads never touch the provider or the project.
 */
export declare function createPiHarnessExtension(options: PiHarnessOptions): (pi: PiExtensionApi) => void;
