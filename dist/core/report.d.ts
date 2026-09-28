import type { AuditEntry, AuditService, Decision, EventContext, GateDefinition, StateSnapshot, ValidatedAnswers } from "./contracts.js";
export declare function digest(value: string): string;
/** Session-scoped JSONL report; do not include commands, prompts, tool outputs, or credentials. */
export declare function createFileAuditService(context: EventContext): AuditService;
export declare function loadAudit(path: string): Promise<readonly AuditEntry[]>;
/** Replay a recorded answer against the same fixture state, without contacting Jev. */
export declare function replayVerdict<Input>(gate: GateDefinition<Input>, input: Input, state: StateSnapshot, answers: ValidatedAnswers, recorded: Decision): boolean;
