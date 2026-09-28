import { createHash } from "node:crypto";
import type {
  AuditEntry, CompactionAcknowledgmentEvent, CompactionDecision, CompactionValidationEvent,
  Decision, EventContext, Harness, HarnessOptions, HarnessServices, Mode, StateSnapshot,
  ToolResultDecision,
} from "./contracts.js";

/**
 * Bootstrap dispatcher. Phase 2 replaces unavailable outcomes with evaluated gate verdicts.
 * Fail-safe: this scaffold never pretends to have evaluated an action.
 */
export function createHarness(services: HarnessServices, options: HarnessOptions = {}): Harness {
  const mode: Mode = options.mode ?? "shadow";
  if (mode !== "shadow" && mode !== "enforce") throw new Error("mode must be shadow or enforce");

  async function decide(context: EventContext, gateId: string): Promise<{ decision: Decision; state: StateSnapshot | null }> {
    if (!context.trusted) return { decision: inert(mode, gateId), state: null };
    let state: StateSnapshot | null;
    try { state = await services.state.read(context); }
    catch { return { decision: unavailable(mode, gateId, "Could not read initialized project state"), state: null }; }
    if (!state) return { decision: inert(mode, gateId), state: null };

    // An incomplete gate has no verdict. In enforce mode it cannot silently pass.
    const decision = unavailable(mode, gateId, "Gate implementation is not installed");
    const entry: AuditEntry = {
      at: (services.now?.() ?? new Date()).toISOString(),
      host: context.host,
      sessionHash: digest(context.sessionId),
      requestHash: digest(context.requestId),
      gateId,
      stateHash: digest(state.revision),
      decision,
      elapsedMs: 0,
    };
    try { await services.audit.append(entry); }
    catch { return { decision: unavailable(mode, gateId, "Could not write audit record"), state }; }
    return { decision, state };
  }

  return {
    async onUserInput(event) { return (await decide(event.context, "user-input")).decision; },
    async onToolPreflight(event) { return (await decide(event.context, "tool-preflight")).decision; },
    async onToolResult(event): Promise<ToolResultDecision> {
      return { decision: (await decide(event.context, "tool-result")).decision };
    },
    async registerAttempt(event) { return (await decide(event.context, "register-attempt")).decision; },
    async recordEvidence(event) { return (await decide(event.context, "record-evidence")).decision; },
    async checkClaim(event) { return (await decide(event.context, "check-claim")).decision; },
    async validateCompaction(event: CompactionValidationEvent): Promise<CompactionDecision> {
      const { decision, state } = await decide(event.context, "validate-compaction");
      // The caller supplies actual prose and an optional typed checkpoint. Neither is
      // synthesized here. The reference block is delivered OUTSIDE note_to_self.
      const retainedPolicyBlock = state ? policyBlock(state) : "";
      return { decision, retainedPolicyBlock };
    },
    async acknowledgeCompaction(event: CompactionAcknowledgmentEvent) {
      return (await decide(event.context, "acknowledge-compaction")).decision;
    },
  };
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function inert(mode: Mode, gateId: string): Decision {
  return { gateId, mode, proposedAction: "none", appliedAction: "none", status: "inert", reason: "Project is uninitialized or untrusted", probabilities: {} };
}
function unavailable(mode: Mode, gateId: string, reason: string): Decision {
  return {
    gateId, mode, proposedAction: "escalate", appliedAction: mode === "enforce" ? "escalate" : "allow",
    status: "unavailable", reason, probabilities: {},
    alternative: "Ask the project owner before proceeding with this action.",
  };
}
function policyBlock(state: StateSnapshot): string {
  const parts = [state.goal.trim(), ...state.constraints.map(rule => `${rule.id}: ${rule.text}`)];
  return parts.some(Boolean) ? `Owner-authored project reference (separate from the agent handoff):\n${parts.filter(Boolean).join("\n")}` : "";
}
