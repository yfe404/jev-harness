import type { Attempt, Evidence, StandingConstraint, StateMutation, TypedCheckpoint } from "../contracts.js";
import { containsKnownSecret } from "../redact.js";

export const MAX_GOAL = 8_000;
export const MAX_CONSTRAINTS = 32_000;
export const MAX_LEDGER = 2_000_000;
export const MAX_SUMMARY = 48_000;

export function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function text(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Invalid ${label}`);
  if (containsKnownSecret(value)) throw new Error(`${label} contains a known credential; ask for sanitized wording`);
  return value;
}
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function list(value: unknown, label: string, max = 255): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}`);
  const ids = value.map((item: unknown) => id(item, label));
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
  return ids;
}
export function validateGoal(value: unknown): string { return text(value, "goal", MAX_GOAL); }
export function validateConstraint(value: unknown): StandingConstraint {
  if (!plainRecord(value)) throw new Error("Invalid constraint");
  const rule = value as unknown as StandingConstraint;
  if (!/^c-[A-Za-z0-9_-]+$/.test(id(rule.id, "constraint id"))) throw new Error("Invalid constraint id");
  if (!/^\d{4}-\d\d-\d\d$/.test(text(rule.createdAt, "constraint date", 10))) throw new Error("Invalid constraint date");
  text(rule.text, "constraint text");
  if (/[\r\n]/.test(rule.text)) throw new Error("Standing constraints must fit on one line");
  if (rule.exceptionTo !== undefined) id(rule.exceptionTo, "exception id");
  return rule;
}
export function validateEvidence(value: unknown): Evidence {
  if (!plainRecord(value)) throw new Error("Invalid evidence");
  const e = value as unknown as Evidence;
  id(e.id, "evidence id");
  if (e.source !== "tool" && e.source !== "harness") throw new Error("Unknown evidence provenance");
  if (!Number.isFinite(Date.parse(text(e.observedAt, "observation time", 40)))) throw new Error("Invalid observation time");
  text(e.method, "evidence method", 1_000);
  text(e.observation, "evidence observation", 8_000);
  if (e.result !== undefined && (e.source !== "harness" || !["confirmed", "refuted", "inconclusive", "setup_failure"].includes(e.result)))
    throw new Error("Only harness evidence can carry a trial result");
  if (e.artifactRef !== undefined) text(e.artifactRef, "artifact reference", 1_000);
  return e;
}
export function validateAttempt(value: unknown): Attempt {
  if (!plainRecord(value)) throw new Error("Invalid attempt");
  const a = value as unknown as Attempt;
  id(a.id, "attempt id");
  text(a.hypothesis, "hypothesis");
  text(a.method, "attempt method");
  if (!["confirmed", "refuted", "inconclusive", "setup_failure"].includes(a.result)) throw new Error("Invalid trial result");
  list(a.evidenceIds, "attempt evidence ids");
  if (typeof a.countsAsTrial !== "boolean" || (a.result === "setup_failure" && a.countsAsTrial)) throw new Error("Invalid trial count");
  if (a.countsAsTrial && a.evidenceIds.length === 0) throw new Error("Trial requires observed evidence");
  return a;
}
export function validateCheckpoint(value: unknown): TypedCheckpoint {
  if (!plainRecord(value)) throw new Error("Invalid typed checkpoint");
  const c = value as unknown as TypedCheckpoint;
  text(c.goalRef, "goal reference", MAX_GOAL);
  if (!Array.isArray(c.rules) || c.rules.length > 255) throw new Error("Invalid checkpoint rules");
  for (const rule of c.rules) text(rule, "checkpoint rule", 4_000);
  if (!Array.isArray(c.hypotheses) || c.hypotheses.length > 255) throw new Error("Invalid checkpoint hypotheses");
  for (const h of c.hypotheses) {
    if (!plainRecord(h)) throw new Error("Invalid checkpoint hypothesis");
    id(h.id, "hypothesis id");
    if (typeof h.status !== "string" || !["open", "confirmed", "refuted", "inconclusive"].includes(h.status)) throw new Error("Invalid hypothesis status");
  }
  list(c.attempts, "checkpoint attempt ids");
  if (!Array.isArray(c.keyDecisions) || c.keyDecisions.length > 255) throw new Error("Invalid checkpoint decisions");
  for (const decision of c.keyDecisions) text(decision, "key decision", 4_000);
  text(c.inProgress, "in progress", 8_000);
  text(c.nextAction, "next action", 8_000);
  return c;
}
export function validateMutation(mutation: StateMutation): void {
  if (!plainRecord(mutation)) throw new Error("Invalid state mutation");
  switch (mutation.kind) {
    case "constraint": validateConstraint(mutation.constraint); break;
    case "attempt":
      validateAttempt(mutation.attempt);
      if (mutation.attempt.result !== "inconclusive" || mutation.attempt.countsAsTrial || mutation.attempt.evidenceIds.length)
        throw new Error("New attempts start inconclusive and do not count as trials");
      break;
    case "evidence": validateEvidence(mutation.evidence); break;
    case "attempt-result":
      id(mutation.attemptId, "attempt id");
      if (!["confirmed", "refuted", "inconclusive", "setup_failure"].includes(mutation.result)) throw new Error("Invalid result");
      list(mutation.evidenceIds, "result evidence ids");
      if (mutation.evidenceIds.length === 0) throw new Error("No observed harness evidence");
      break;
    case "checkpoint":
      validateCheckpoint(mutation.checkpoint);
      if (mutation.appliedValidationId !== undefined) id(mutation.appliedValidationId, "validation id");
      break;
    case "compaction-ack":
      id(mutation.compactionId, "compaction id"); id(mutation.validationId, "validation id");
      if (mutation.checkpoint !== undefined) validateCheckpoint(mutation.checkpoint);
      if (mutation.countEvidence !== undefined && typeof mutation.countEvidence !== "boolean") throw new Error("Invalid countEvidence flag");
      break;
    default: throw new Error("Unknown state mutation");
  }
}
