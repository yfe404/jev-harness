export type Host = "claude-code" | "pi" | "cli";
export type Mode = "shadow" | "enforce";
export type DecisionStatus = "ready" | "inert" | "unavailable" | "escalation";
export type Action = "none" | "allow" | "block" | "confirm" | "capture" | "freeze" | "redact" | "remind" | "replan" | "halt" | "escalate";
/** The adapter establishes trust; the model may not set any of these fields. */
export interface EventContext {
    readonly host: Host;
    readonly projectRoot: string;
    readonly sessionId: string;
    /** One user request, including all tool/model turns and queued work it starts. */
    readonly requestId: string;
    readonly trusted: boolean;
}
export interface UserInputEvent {
    readonly context: EventContext;
    readonly text: string;
    readonly source: "user" | "extension" | "agent";
}
/** Called only after the host has accepted a fresh, authentic human request for execution.
 * A queued prompt, extension handoff, Stop, or agent settlement is not an accepted request.
 * The adapter must use the same requestId for this transition and its onUserInput call.
 */
export interface AcceptedUserRequestEvent {
    readonly context: EventContext;
    readonly source: "user";
    readonly accepted: true;
}
export interface AcceptedUserRequestTransition {
    readonly decision: Decision;
    /** False on a retry of a requestId already accepted in this session. Skip onUserInput then. */
    readonly fresh: boolean;
    /** A different request's active correction freeze was released. */
    readonly releasedPriorFreeze: boolean;
}
export interface ToolPreflightEvent {
    readonly context: EventContext;
    readonly callId: string;
    readonly toolName: string;
    readonly intent: "shell" | "read" | "write" | "edit" | "other";
    readonly input: Readonly<Record<string, unknown>>;
}
export interface ToolResultEvent extends ToolPreflightEvent {
    readonly output: unknown;
    readonly isError: boolean;
    /** False for hosts which can add advisory context but cannot replace tool output. */
    readonly canReplaceOutput: boolean;
}
/** Echoes Jev's System One question shape. Prompts describe judgments, never thresholds. */
export type NoulQuestion = Readonly<{
    type: "noul";
    instructions: string;
    criteria: Readonly<{
        true: string;
        false: string;
    }>;
}>;
export type ChoiceQuestion = Readonly<{
    type: "choice";
    instructions: string;
    /** Must include a none or other exit. */
    criteria: Readonly<Record<string, string>>;
}>;
export type ScoreQuestion = Readonly<{
    type: "score";
    instructions: string;
    criteria: readonly [string, string, ...string[]];
}>;
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type QuestionMap = Readonly<Record<string, Question>>;
/** Validated locally from untrusted provider JSON; unavailable fields are never guessed. */
export type ValidatedAnswer = Readonly<{
    type: "noul";
    probabilityTrue: number;
    confidence: number;
}> | Readonly<{
    type: "choice";
    label: string;
    confidence: number;
    probabilities: Readonly<Record<string, number>>;
}> | Readonly<{
    type: "score";
    value: number;
    confidence: number;
    probabilities: Readonly<Record<string, number>>;
}>;
export type ValidatedAnswers = Readonly<Record<string, ValidatedAnswer>>;
export interface GateQuery {
    readonly state: string | Readonly<Record<string, unknown>>;
    readonly questions: QuestionMap;
}
export interface GateVerdict {
    readonly action: Action;
    readonly reason: string;
    /** A human-usable, authorized alternative for blocks or escalations. */
    readonly alternative?: string;
}
export interface GateDefinition<Input> {
    readonly id: string;
    /** All numbers used to decide whether to act are in this file, not in a prompt. */
    readonly thresholds: Readonly<Record<string, number>>;
    prepare(input: Input, state: StateSnapshot): GateQuery | null;
    evaluate(input: Input, answers: ValidatedAnswers, state: StateSnapshot): GateVerdict;
}
export interface Decision {
    readonly gateId: string;
    readonly mode: Mode;
    /** The gate's judgment, even in shadow mode. */
    readonly proposedAction: Action;
    /** What the adapter is authorized to perform. Shadow mode never applies a gate verdict. */
    readonly appliedAction: Action;
    readonly status: DecisionStatus;
    readonly reason: string;
    /** Named probabilities from validated answers; no raw input, secret, or output. */
    readonly probabilities: Readonly<Record<string, number>>;
    readonly alternative?: string;
    readonly validationId?: string;
    /** Id of a successfully committed constraint, attempt, or evidence entry. */
    readonly recordedId?: string;
    /** Dedup comparisons may be capped; a partial search never claims complete coverage. */
    readonly coverage?: Readonly<{
        checked: number;
        total: number;
        complete: boolean;
    }>;
    /** Trailing successful compaction cycles without new confirmed/refuted evidence;
     * present only when the evidence workflow is enabled. */
    readonly stagnantCycles?: number;
}
export interface ToolResultDecision {
    readonly decision: Decision;
    /** Present only when output replacement is supported and explicitly selected. */
    readonly replacement?: unknown;
}
export interface StandingConstraint {
    readonly id: string;
    readonly createdAt: string;
    readonly text: string;
    /** Human-authored exception; a model cannot grant itself an override. */
    readonly exceptionTo?: string;
}
export type TrialResult = "confirmed" | "refuted" | "inconclusive" | "setup_failure";
export interface Evidence {
    readonly id: string;
    readonly source: "tool" | "harness";
    readonly observedAt: string;
    readonly method: string;
    readonly observation: string;
    /** Only the trusted harness can attach a result derived from structured observations. */
    readonly result?: TrialResult;
    readonly artifactRef?: string;
}
export interface Attempt {
    readonly id: string;
    readonly hypothesis: string;
    readonly method: string;
    readonly result: TrialResult;
    readonly evidenceIds: readonly string[];
    readonly countsAsTrial: boolean;
}
/** Optional agent-authored checkpoint. Its absence never causes facts to be fabricated. */
export interface TypedCheckpoint {
    readonly goalRef: string;
    readonly rules: readonly string[];
    readonly hypotheses: readonly {
        id: string;
        status: "open" | "confirmed" | "refuted" | "inconclusive";
    }[];
    readonly attempts: readonly string[];
    readonly keyDecisions: readonly string[];
    readonly inProgress: string;
    readonly nextAction: string;
}
/** One successful, unique compaction cycle. `evidence` is the target-evidence
 * mark (hash of the confirmed/refuted evidence ids) at acknowledgment time;
 * null means the cycle predates cycle tracking and never counts as stagnant. */
export interface CompactionCycle {
    readonly id: string;
    readonly evidence: string | null;
}
export interface StateSnapshot {
    readonly revision: string;
    readonly goal: string;
    readonly constraints: readonly StandingConstraint[];
    readonly attempts: readonly Attempt[];
    readonly evidence: readonly Evidence[];
    readonly summary: TypedCheckpoint | null;
    /** Successful, unique compaction acknowledgments only. */
    readonly compactionIds: readonly string[];
    /** Cycle identity and target-evidence mark per acknowledged compaction, in
     * acknowledgment order. Absent only for custom state services predating it. */
    readonly compactionCycles?: readonly CompactionCycle[];
    /** Validation ids whose checkpoint application completed durably. A replayed
     * acknowledgment with a recorded marker must not republish its checkpoint. */
    readonly checkpointAcks?: readonly string[];
}
export type StateMutation = Readonly<{
    kind: "constraint";
    constraint: StandingConstraint;
}> | Readonly<{
    kind: "attempt";
    attempt: Attempt;
}> | Readonly<{
    kind: "evidence";
    evidence: Evidence;
}> | Readonly<{
    kind: "attempt-result";
    attemptId: string;
    result: TrialResult;
    evidenceIds: readonly string[];
}> | Readonly<{
    kind: "checkpoint";
    checkpoint: TypedCheckpoint;
    appliedValidationId?: string;
}>
/** Atomic compaction application: appends the stagnation counter/cycle (unless
 * countEvidence === false), publishes the merged validated checkpoint when
 * supplied, and records the validationId in checkpointAcks — all in one
 * compare-and-swap write, so an interrupted acknowledgment recovers as a
 * single retry and a replayed one is a pure no-op. */
 | Readonly<{
    kind: "compaction-ack";
    compactionId: string;
    validationId: string;
    checkpoint?: TypedCheckpoint;
    countEvidence?: boolean;
}>;
export interface RegisterAttemptEvent {
    readonly context: EventContext;
    readonly hypothesis: string;
    readonly method: string;
    readonly changedVariable?: string;
}
export interface RecordEvidenceEvent {
    readonly context: EventContext;
    /** Must refer to observed tool/harness data, not an agent's assertion of success. */
    readonly evidence: Evidence;
    readonly attemptId?: string;
    readonly result?: TrialResult;
}
export interface CheckClaimEvent {
    readonly context: EventContext;
    readonly claim: string;
    readonly evidenceIds: readonly string[];
    readonly purpose: "checkpoint" | "commit" | "explicit";
    readonly comparison?: Readonly<{
        control: Readonly<Record<string, unknown>>;
        treatment: Readonly<Record<string, unknown>>;
        variedKey: string;
    }>;
}
export interface CompactionValidationEvent {
    readonly context: EventContext;
    /** Actual candidate summary prose (may be empty only when noteToSelf exists). */
    readonly summaryText: string;
    /** Original, unmodified text supplied by the agent, when the host has a handoff note. */
    readonly noteToSelf?: string;
    readonly checkpoint?: TypedCheckpoint;
    readonly reason: "manual" | "threshold" | "overflow" | "external";
}
export interface CompactionDecision {
    readonly decision: Decision;
    /** Canonical policy to inject separately; never part of or a replacement for the note. */
    readonly retainedPolicyBlock: string;
}
export interface CompactionAcknowledgmentEvent {
    readonly context: EventContext;
    readonly compactionId: string;
    readonly validationId: string;
    readonly succeeded: true;
    /** compactionCandidateHash of the exact validated candidate; verified against
     * the registry record when supplied. */
    readonly candidateHash?: string;
    /** The exact checkpoint accepted at validation; persisted only when it matches
     * the recorded checkpointHash. Never invented from prose. */
    readonly checkpoint?: TypedCheckpoint;
}
/** Durable record binding one validated compaction candidate to its provenance.
 * Contains hashes only; candidate prose is never stored in the registry. */
export interface CompactionValidationRecord {
    readonly validationId: string;
    readonly host: Host;
    readonly projectHash: string;
    readonly sessionHash: string;
    readonly requestHash: string;
    readonly mode: Mode;
    /** State revision the candidate was judged against; an ack after a change is stale. */
    readonly stateRevision: string;
    /** Hash of the exact candidate summary/note/checkpoint bytes. */
    readonly candidateHash: string;
    /** Hash of the validated typed checkpoint alone, when one was supplied. The
     * checkpoint itself is never stored; an ack must resend it for persistence. */
    readonly checkpointHash?: string;
    readonly createdAt: string;
}
export interface CompactionRegistry {
    /** Persist a new validation record durably; a duplicate validationId is an error. */
    save(record: CompactionValidationRecord): Promise<void>;
    /** Folded record plus its acknowledged compactionId, or null when unknown. */
    get(validationId: string): Promise<Readonly<{
        record: CompactionValidationRecord;
        compactionId?: string;
    }> | null>;
    /** Bind one compactionId. Repeating the same compactionId is an idempotent retry;
     * a different compactionId for the same validationId throws, as does a
     * compactionId already bound to a different validationId. */
    acknowledge(validationId: string, compactionId: string): Promise<void>;
    /** Reverse binding lookup: the validationId bound to a compactionId, or null. */
    lookupCompaction?(compactionId: string): Promise<string | null>;
}
export interface ProviderRequest {
    readonly state: GateQuery["state"];
    readonly questions: QuestionMap;
}
export interface DecisionProvider {
    /** Returns raw, untrusted System One answers. Caller validates them. */
    decide(request: ProviderRequest, signal?: AbortSignal): Promise<unknown>;
}
export interface StateService {
    /** null means the project was not explicitly initialized; never create state on read. */
    read(context: EventContext): Promise<StateSnapshot | null>;
    /** Atomic compare-and-swap; reject a stale expectedRevision. */
    write(context: EventContext, expectedRevision: string, mutation: StateMutation): Promise<StateSnapshot>;
}
export interface AuditEntry {
    readonly at: string;
    readonly host: Host;
    readonly sessionHash: string;
    readonly requestHash: string;
    readonly gateId: string;
    readonly stateHash: string;
    readonly decision: Decision;
    /** Validated Jev answers for offline replay; never include raw prompt or state. */
    readonly answers?: ValidatedAnswers;
    readonly elapsedMs: number;
}
export interface AuditService {
    /** Must complete durably before an enforcement verdict reaches the adapter. */
    append(entry: AuditEntry): Promise<void>;
}
export interface RuntimeService {
    get(context: EventContext): Promise<Readonly<{
        frozen: boolean;
        planReviewed: boolean;
    }>>;
    /** Atomically remembers an accepted request and releases a different request's session freeze.
     * Returns fresh=false for retries, which must not re-run user-input capture or correction detection.
     */
    accept(context: EventContext): Promise<Readonly<{
        fresh: boolean;
        releasedPriorFreeze: boolean;
    }>>;
    freeze(context: EventContext): Promise<void>;
    /** Explicit owner reset only. Do not call from Stop, turn_end, or agent settlement. */
    clear(context: EventContext): Promise<void>;
    markPlanReviewed(context: EventContext): Promise<void>;
}
export interface HarnessServices {
    readonly provider: DecisionProvider;
    readonly state: StateService;
    readonly audit: AuditService;
    /** Optional injected request lock service; defaults to session-scoped local files. */
    readonly runtime?: RuntimeService;
    /** Optional injected compaction validation registry; defaults to durable files under
     * the project's ignored `.harness/runtime/` directory. */
    readonly compactionRegistry?: CompactionRegistry;
    readonly now?: () => Date;
}
export interface HarnessOptions {
    readonly mode?: Mode;
    readonly signal?: AbortSignal;
    /** Opt-in experiment/evidence workflow. Only when true does a unique successful
     * compaction acknowledgment advance the durable compaction counter used for
     * evidence-stagnation tracking. Default false: acknowledgments are still
     * validated, deduplicated, and audited, but counters never move. */
    readonly evidenceWorkflow?: boolean;
}
export interface Harness {
    /** Call after host acceptance, before onUserInput; only call onUserInput if fresh=true. */
    acceptUserRequest(event: AcceptedUserRequestEvent): Promise<AcceptedUserRequestTransition>;
    onUserInput(event: UserInputEvent): Promise<Decision>;
    onToolPreflight(event: ToolPreflightEvent): Promise<Decision>;
    onToolResult(event: ToolResultEvent): Promise<ToolResultDecision>;
    registerAttempt(event: RegisterAttemptEvent): Promise<Decision>;
    recordEvidence(event: RecordEvidenceEvent): Promise<Decision>;
    checkClaim(event: CheckClaimEvent): Promise<Decision>;
    validateCompaction(event: CompactionValidationEvent): Promise<CompactionDecision>;
    acknowledgeCompaction(event: CompactionAcknowledgmentEvent): Promise<Decision>;
}
