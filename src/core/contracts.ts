// Public contracts shared by the core, CLI, Claude Code hooks, and Pi extension.
// NodeNext imports in implementation files must use .js suffixes.

export type Host = "claude-code" | "pi" | "cli";
export type Mode = "shadow" | "enforce";
export type DecisionStatus = "ready" | "inert" | "unavailable" | "escalation";
export type Action =
  | "none" | "allow" | "block" | "confirm" | "capture" | "freeze"
  | "redact" | "remind" | "replan" | "halt" | "escalate";

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
  criteria: Readonly<{ true: string; false: string }>;
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
export type ValidatedAnswer =
  | Readonly<{ type: "noul"; probabilityTrue: number; confidence: number }>
  | Readonly<{ type: "choice"; label: string; confidence: number; probabilities: Readonly<Record<string, number>> }>
  | Readonly<{ type: "score"; value: number; confidence: number; probabilities: Readonly<Record<string, number>> }>;
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
  readonly hypotheses: readonly { id: string; status: "open" | "confirmed" | "refuted" | "inconclusive" }[];
  readonly attempts: readonly string[];
  readonly keyDecisions: readonly string[];
  readonly inProgress: string;
  readonly nextAction: string;
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
}
export type StateMutation =
  | Readonly<{ kind: "constraint"; constraint: StandingConstraint }>
  | Readonly<{ kind: "attempt"; attempt: Attempt }>
  | Readonly<{ kind: "evidence"; evidence: Evidence }>
  | Readonly<{ kind: "checkpoint"; checkpoint: TypedCheckpoint }>
  | Readonly<{ kind: "compaction-ack"; compactionId: string; validationId: string }>;

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
  readonly comparison?: Readonly<{ control: Readonly<Record<string, unknown>>; treatment: Readonly<Record<string, unknown>>; variedKey: string }>;
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
  readonly elapsedMs: number;
}
export interface AuditService {
  /** Must complete durably before an enforcement verdict reaches the adapter. */
  append(entry: AuditEntry): Promise<void>;
}
export interface HarnessServices {
  readonly provider: DecisionProvider;
  readonly state: StateService;
  readonly audit: AuditService;
  readonly now?: () => Date;
}
export interface HarnessOptions {
  readonly mode?: Mode; // default: shadow, including initialized projects
  readonly signal?: AbortSignal;
}
export interface Harness {
  onUserInput(event: UserInputEvent): Promise<Decision>;
  onToolPreflight(event: ToolPreflightEvent): Promise<Decision>;
  onToolResult(event: ToolResultEvent): Promise<ToolResultDecision>;
  registerAttempt(event: RegisterAttemptEvent): Promise<Decision>;
  recordEvidence(event: RecordEvidenceEvent): Promise<Decision>;
  checkClaim(event: CheckClaimEvent): Promise<Decision>;
  validateCompaction(event: CompactionValidationEvent): Promise<CompactionDecision>;
  acknowledgeCompaction(event: CompactionAcknowledgmentEvent): Promise<Decision>;
}
