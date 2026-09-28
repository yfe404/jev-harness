// Pi adapter: maps Pi extension events onto the frozen Harness API.
//
// Hard rules implemented here:
// - The factory is inert: no provider traffic, file access, or state mutation
//   until a session starts for a trusted, explicitly initialized project.
//   A corrupt initialized project is NOT silently inert: enforce mode blocks
//   tool use until the owner repairs .harness/.
// - Only an authentic, actually-delivered user prompt advances request state:
//   the fresh-request transition is deferred to before_agent_start (the point
//   where Pi has accepted the prompt for execution), never to the input hook,
//   which still runs before transforms, handled-shortcuts, and queueing.
//   Extension-injected messages and queued steering/follow-up input never
//   release a correction freeze; live stop/steer corrections are classified
//   immediately (they can freeze) without becoming a new request. A freeze is
//   never cleared at turn_end, agent_end, agent_settled, or session events.
//   The accepted request identity is persisted on the branch (appendEntry) so
//   reload and tree navigation restore it, and stale async completions cannot
//   mutate the state of a newer request.
// - A correction freeze blocks every agent tool, including the harness's own
//   register/claim/evidence tools and the self-compact recovery whitelist
//   (self_compact/view_context): that whitelist belongs to the compaction
//   lock, not to a text-only correction freeze.
// - Pi tool_result can replace output; G3 replacements become text content.
// - Canonical policy is restored through the `context` hook before every model
//   call, which covers self-compact, native/manual compaction, overflow
//   continuation, and branch navigation alike. Native overflow recovery stays
//   Pi's own path; the adapter never requires a note or checkpoint tool.
// - session_compact acknowledgment uses the actual latest persisted compaction
//   entry on the active branch (never blindly the event's entry id, which Pi
//   0.85.1 can resolve to an older entry when two summaries are identical),
//   requires the namespaced validation id written by the validator, and is
//   bound to the persisted identity of the request that validated the
//   candidate (details.jevHarness.requestId), not whatever request happens to
//   be active when the event fires. The candidate hash is recomputed from the
//   actual persisted summary and the preserved note/checkpoint bytes — never
//   echoed from metadata — so a summary modified after validation is not
//   acknowledged. Held, failed, and forged acknowledgments are surfaced
//   through the UI and the bridge, never swallowed.
// - Evidence is recorded only from screened-safe tool results the model
//   actually sees unmodified (never raw withheld/private/injected output),
//   with the observed target and error status included. The agent can
//   register attempts and check claims; it cannot create evidence.
import { randomUUID } from "node:crypto";
import type {
  CompactionAcknowledgmentEvent, Decision, EventContext, Evidence, Harness, Mode, RuntimeService, StateSnapshot, ToolResultDecision, TypedCheckpoint,
} from "../../core/contracts.js";
import { compactionCandidateHash } from "../../core/compaction.js";
import { readProject } from "../../core/state/files.js";
import { createFileRuntimeService } from "../../core/state/locks.js";
import { redactText } from "../../core/redact.js";
import { buildRetainedPolicyBlock } from "../../core/compaction.js";
import {
  contentText, intentForTool, oneLine,
  type PiBeforeAgentStartEvent, type PiContextEvent, type PiExtensionApi, type PiExtensionContext, type PiInputEvent,
  type PiMessageLike, type PiSessionCompactEvent, type PiSessionEntryLike, type PiToolCallEvent,
  type PiToolCallResult, type PiToolResultEvent, type PiToolResultPatch,
} from "./types.js";

export const ATTEMPT_TOOL = "jev_register_attempt";
export const CLAIM_TOOL = "jev_check_claim";
export const EVIDENCE_TOOL = "jev_evidence";
/** Transient custom-message type carrying the restored canonical policy. */
export const POLICY_MESSAGE_TYPE = "jev-harness-policy";

const HARNESS_TOOLS: readonly string[] = [ATTEMPT_TOOL, CLAIM_TOOL, EVIDENCE_TOOL];
const EVIDENCE_CAP = 500;
const POLICY_CAP_DEFAULT = 3000;
/** Custom entry type persisting the accepted request identity on the branch. */
export const REQUEST_ENTRY_TYPE = "jev-harness-request";

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

interface Session {
  readonly harness: Harness;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly trusted: boolean;
  /** Resolved per-session mode (env override, config file, or the static default). */
  readonly mode: Mode;
  /** Set when initialized state could not be read: enforce blocks instead of going inert. */
  readonly stateError?: string;
}

const fallbackRequestId = (sessionId: string) => `req-session-${sessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24) || "unknown"}`;
const newRequestId = () => `req-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/[\n\r\0]+/g, " ").slice(0, 300);

/** Canonical retained policy (goal, standing rules, preserved decisions). When
 * the block exceeds the injection limit the view says so explicitly; a
 * truncated policy never claims complete retention. */
function policyBlock(state: StateSnapshot, limit: number): string {
  const block = buildRetainedPolicyBlock(state);
  if (block.length <= limit) return block;
  return `${block.slice(0, limit)}\n[truncated: ${block.length - limit} more characters of authoritative policy exist in .harness/ (goal.md, constraints.md, preserved decisions); treat omitted rules as unknown, never as absent]`;
}

/**
 * Build the Pi extension. The returned factory registers handlers only; all
 * state/service work is deferred to session_start and later events, so model
 * catalog probes and discovery loads never touch the provider or the project.
 */
export function createPiHarnessExtension(options: PiHarnessOptions): (pi: PiExtensionApi) => void {
  const configuredMode = options.mode ?? "shadow";
  const runtime = options.runtime ?? createFileRuntimeService();
  const readState = options.readState ?? readProject;
  const authenticSources = options.authenticSources ?? ["interactive", "rpc"];
  const now = options.now ?? (() => new Date());

  return function piHarnessExtension(pi: PiExtensionApi): void {
    let session: Session | null = null;
    let currentRequestId: string | null = null;
    let lastCtx: PiExtensionContext | null = null;
    /** Authentic idle prompt awaiting actual acceptance at before_agent_start. */
    let pendingAuthenticInput: { text: string } | null = null;
    /** Initialization failed after the project resolved as initialized: enforce
     * blocks tools instead of silently passing everything. */
    let failedInit: { mode: Mode; error: string } | null = null;
    /** In-session fail-closed hold: an accepted request whose classification
     * was unavailable/escalated/thrown stays frozen even if the lock write
     * failed. Cleared only by a successfully classified later request. */
    let classificationHold: string | null = null;
    /** The accepted request identity could not be persisted; a reload could
     * resurrect an abandoned identity, so enforce holds until the next
     * classified request re-persists it. */
    let identityPersistFailed = false;

    const activeHold = (): string | null => classificationHold ??
      (identityPersistFailed ? "the accepted request identity is not durable; a reload could bind state to an abandoned request" : null);

    const contextFor = (ctx: PiExtensionContext, requestId: string): EventContext => ({
      host: "pi",
      projectRoot: session?.projectRoot ?? ctx.cwd,
      sessionId: session?.sessionId ?? ctx.sessionManager.getSessionId(),
      requestId,
      trusted: (session?.trusted ?? true) && safeTrusted(ctx),
    });
    const safeTrusted = (ctx: PiExtensionContext): boolean => {
      try { return ctx.isProjectTrusted(); } catch { return false; }
    };
    const requestId = () => currentRequestId ?? fallbackRequestId(session?.sessionId ?? "unknown");

    if (options.bridge) {
      options.bridge.currentContext = () => (session && lastCtx ? contextFor(lastCtx, requestId()) : null);
      options.bridge.harnessForSession = () => session?.harness ?? null;
      options.bridge.mode = () => session?.mode ?? configuredMode;
    }

    async function isFrozen(context: EventContext): Promise<boolean | null> {
      try { return (await runtime.get(context)).frozen; } catch { return null; }
    }

    function freezeBlockReason(): string {
      return "Tool use is frozen by a user correction. Reply in text only: acknowledge the correction, explain what you did and why, then wait for the next user message.";
    }

    /** Correction/capture classification of authentic user text; never blocks
     * or transforms the prompt. Returns the decision so callers can fail closed
     * when an accepted request stayed unclassified. */
    async function classifyUserInput(s: Session, context: EventContext, text: string, ctx: PiExtensionContext): Promise<Decision> {
      const decision = await s.harness.onUserInput({ context, text, source: "user" });
      if (decision.appliedAction === "freeze") {
        ctx.ui.notify(`jev-harness: ${oneLine(decision.reason)}`, "warning");
      } else if (decision.appliedAction === "capture" && decision.recordedId) {
        ctx.ui.notify(`jev-harness: recorded standing rule ${decision.recordedId}.`, "info");
      } else if (decision.appliedAction === "escalate") {
        ctx.ui.notify(`jev-harness: ${oneLine(decision.reason)}`, "warning");
      }
      return decision;
    }

    /** Fail closed on an unclassified request: persist a correction freeze;
     * even when the lock write fails the in-memory hold still stops tools. */
    async function holdUnclassified(s: Session, context: EventContext, reason: string, ctx: PiExtensionContext): Promise<void> {
      try { await runtime.freeze(context); } catch { /* the in-memory hold below still stops tools */ }
      classificationHold = reason;
      try { ctx.ui.notify(`jev-harness: ${oneLine(reason)}; holding tools until the next classified request.`, "warning"); } catch { /* best-effort */ }
    }

    /** Synthetic non-ready acknowledgment decision surfaced to the bridge so
     * the composition pauses continuation instead of assuming coverage. */
    const ackFailure = (s: Session, reason: string): Decision => ({
      gateId: "acknowledge-compaction", mode: s.mode, status: "unavailable",
      proposedAction: "escalate", appliedAction: s.mode === "enforce" ? "escalate" : "none",
      reason, probabilities: {},
    });

    /** Restore the persisted accepted-request identity after reload/tree
     * navigation. A branch without a marker resets to the fallback identity —
     * never keep an abandoned branch's request id. */
    function restoreRequestIdentity(ctx: PiExtensionContext): void {
      try {
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry?.type === "custom" && entry.customType === REQUEST_ENTRY_TYPE) {
            const data = entry.data as { requestId?: unknown } | undefined;
            if (typeof data?.requestId === "string" && data.requestId) {
              currentRequestId = data.requestId;
              return;
            }
          }
        }
        currentRequestId = null;
      } catch { /* identity restoration is best-effort */ }
    }

    // ------------------------------------------------------------- events

    pi.on("session_start", async (_event: unknown, ctx: PiExtensionContext) => {
      lastCtx = ctx;
      currentRequestId = null;
      pendingAuthenticInput = null;
      classificationHold = null;
      identityPersistFailed = false;
      failedInit = null;
      session = null;
      if (!safeTrusted(ctx)) return;
      const sessionId = ctx.sessionManager.getSessionId();
      // Resolve the project root the same way the CLI does (nearest directory
      // holding a real .harness/); a read failure is corruption, not absence.
      let root: string | null = null;
      let failure: unknown;
      try { root = (await options.findProjectRoot?.(ctx.cwd)) ?? ctx.cwd; }
      catch (error) { failure = error; }
      let state: StateSnapshot | null = null;
      if (failure === undefined && root) {
        try { state = await readState(root); }
        catch (error) { failure = error; }
      }
      // Truly uninitialized projects stay inert: never create state. Corrupt
      // initialized state continues as a blocked (enforce) session instead of
      // silently dropping every gate.
      if (!state && failure === undefined) return;
      let mode = configuredMode;
      const base: EventContext = {
        host: "pi", projectRoot: root ?? ctx.cwd, sessionId,
        requestId: fallbackRequestId(sessionId), trusted: true,
      };
      if (options.resolveMode) {
        try { mode = await options.resolveMode(base); }
        catch (error) {
          // Mode resolution failed (e.g. a corrupt .harness/config.json): fail
          // closed. An explicitly known-valid shadow override (JH_MODE=shadow)
          // is returned by the resolver itself and never reaches this branch,
          // so an unresolved mode always becomes enforce, never default shadow.
          failure ??= error;
          mode = "enforce";
        }
      }
      let harness: Harness | null = null;
      try { harness = options.harness ?? options.createHarnessForSession?.(base, mode) ?? null; }
      catch (error) {
        // A harness factory error must not degrade an enforce project into an
        // inert session that passes every tool call.
        failedInit = { mode, error: errorText(error) };
        try { ctx.ui.notify(`jev-harness: could not start the session harness (${failedInit.error}); ${mode === "enforce" ? "blocking tools until repaired" : "observing only (shadow)"}.`, "warning"); } catch { /* best-effort */ }
        return;
      }
      if (!harness) {
        if (mode === "enforce") failedInit = { mode, error: "no harness factory produced a session harness" };
        return;
      }
      session = { harness, projectRoot: base.projectRoot, sessionId, trusted: true, mode,
        ...(failure !== undefined ? { stateError: errorText(failure) } : {}) };
      restoreRequestIdentity(ctx);
      try { ctx.ui.setStatus?.("jev-harness", `jev-harness ${mode}${session.stateError ? " (state unavailable)" : ""}`); } catch { /* status is best-effort */ }
      if (session.stateError) {
        try { ctx.ui.notify(`jev-harness: project state unavailable (${session.stateError}); ${mode === "enforce" ? "blocking tools until repaired" : "observing only (shadow)"}.`, "warning"); } catch { /* best-effort */ }
      }
    });

    pi.on("session_shutdown", async () => {
      session = null;
      currentRequestId = null;
      pendingAuthenticInput = null;
      classificationHold = null;
      identityPersistFailed = false;
      failedInit = null;
      lastCtx = null;
    });

    pi.on("session_tree", async (_event: unknown, ctx: PiExtensionContext) => {
      lastCtx = ctx;
      if (session) restoreRequestIdentity(ctx);
    });

    pi.on("input", async (event: PiInputEvent, ctx: PiExtensionContext) => {
      lastCtx = ctx;
      const s = session;
      if (!s || typeof event.text !== "string") return undefined;
      // Only authentic host sources count; extension-injected messages are
      // never requests, never release a correction freeze, and never discard a
      // pending idle prompt awaiting acceptance.
      if (!event.source || !authenticSources.includes(event.source)) return undefined;
      if (event.streamingBehavior !== undefined) {
        // Mid-stream steer / queued follow-up: classify the correction now (a
        // live "stop" must freeze tools immediately) against the CURRENT
        // request. Queued future prompts never become an accepted request and
        // never release a freeze. A classification that cannot run fails closed.
        const context = contextFor(ctx, requestId());
        try {
          const decision = await classifyUserInput(s, context, event.text, ctx);
          if (s.mode === "enforce" && (decision.status !== "ready" || decision.appliedAction === "escalate"))
            await holdUnclassified(s, context, `a correction could not be classified (${oneLine(decision.reason)})`, ctx);
        } catch (error) {
          if (s.mode === "enforce")
            await holdUnclassified(s, context, `correction classification failed (${errorText(error)})`, ctx);
        }
        return undefined;
      }
      // Idle prompt: defer the fresh-request transition to before_agent_start,
      // where Pi has actually accepted the prompt for execution. The input
      // hook still runs before transforms, handled-shortcuts, and failures. A
      // new authentic idle prompt supersedes any stale pending one.
      pendingAuthenticInput = { text: event.text };
      return undefined;
    });

    pi.on("before_agent_start", async (event: PiBeforeAgentStartEvent, ctx: PiExtensionContext) => {
      lastCtx = ctx;
      const s = session;
      const pending = pendingAuthenticInput;
      pendingAuthenticInput = null;
      if (!s || !pending) return undefined;
      // Tie acceptance to the actual delivered prompt: pi.sendUserMessage
      // always triggers a turn, so a before_agent_start whose prompt is not
      // the pending one must never consume it (an extension-triggered turn is
      // not an authentic user request and never releases a freeze).
      if (event && typeof event.prompt === "string" && event.prompt !== pending.text) return undefined;
      const id = newRequestId();
      const context = contextFor(ctx, id);
      try {
        const transition = await s.harness.acceptUserRequest({ context, source: "user", accepted: true });
        if (session !== s) return undefined; // the session switched while awaiting
        if (!transition.fresh || transition.decision.status !== "ready") return undefined;
        currentRequestId = id;
        // Persist the accepted request identity so reload and tree navigation
        // restore it and stale async completions cannot rebind a new request.
        // In enforce a persistence failure is a hold, not best-effort: a
        // reload would otherwise bind state to an abandoned request identity.
        let persistedIdentity = true;
        try {
          if (typeof pi.appendEntry !== "function") persistedIdentity = false;
          else pi.appendEntry(REQUEST_ENTRY_TYPE, { requestId: id, at: now().toISOString() });
        } catch { persistedIdentity = false; }
        identityPersistFailed = !persistedIdentity;
        if (identityPersistFailed && s.mode === "enforce") {
          try { ctx.ui.notify("jev-harness: could not persist the accepted request identity; holding tools until the next classified request.", "warning"); } catch { /* best-effort */ }
        }
        options.bridge?.onAcceptedRequest?.(context);
        // Classify the accepted request. The accept above already released any
        // prior freeze, so a classification that is unavailable, escalated, or
        // thrown must fail closed: persist a fresh freeze and hold in-session.
        try {
          const decision = await classifyUserInput(s, context, pending.text, ctx);
          if (session !== s) return undefined;
          classificationHold = null;
          if (s.mode === "enforce" && (decision.status !== "ready" || decision.appliedAction === "escalate"))
            await holdUnclassified(s, context, `the accepted request could not be classified (${oneLine(decision.reason)})`, ctx);
        } catch (error) {
          if (s.mode === "enforce")
            await holdUnclassified(s, context, `the accepted request could not be classified (${errorText(error)})`, ctx);
        }
      } catch {
        // Input handling never blocks or transforms the user's own prompt.
      }
      return undefined;
    });

    pi.on("tool_call", async (event: PiToolCallEvent, ctx: PiExtensionContext): Promise<PiToolCallResult | undefined> => {
      lastCtx = ctx;
      const s = session;
      if (!s) {
        // An enforce project whose harness could not start is blocked, never
        // silently inert. Shadow stays observational.
        if (failedInit && failedInit.mode === "enforce" && typeof event.toolName === "string")
          return { block: true, reason: `jev-harness could not start (${oneLine(failedInit.error)}); blocked in enforce mode until the owner repairs .harness/` };
        return undefined;
      }
      if (typeof event.toolName !== "string") return undefined;
      const context = contextFor(ctx, requestId());
      // Corrupt initialized state blocks in enforce instead of going inert.
      if (s.stateError && s.mode === "enforce") {
        return { block: true, reason: `jev-harness project state is unavailable (${oneLine(s.stateError)}); blocked in enforce mode until the owner repairs .harness/` };
      }
      // In-session fail-closed holds (unclassified accepted request, unpersisted
      // request identity) stop every tool in enforce. Shadow never blocks.
      if (s.mode === "enforce") {
        const hold = activeHold();
        if (hold) return { block: true, reason: `jev-harness hold: ${oneLine(hold)}. Reply in text only until the next classified user request.` };
      }
      // A correction freeze blocks every tool — the harness's own
      // register/claim/evidence tools and the self-compact recovery whitelist
      // included. The whitelist only skips the unknown-intent escalation; it
      // belongs to the compaction lock, not to a text-only correction freeze.
      // Freeze enforcement is enforce-mode only: shadow is purely observational
      // (a freeze persisted by another session must be ignored here).
      if (HARNESS_TOOLS.includes(event.toolName) || options.exemptTools?.includes(event.toolName)) {
        if (s.mode !== "enforce") return undefined;
        const frozen = await isFrozen(context);
        if (frozen === true) return { block: true, reason: freezeBlockReason() };
        if (frozen === null) {
          return { block: true, reason: "jev-harness cannot verify correction state; blocked in enforce mode" };
        }
        return undefined; // harness tools run their gates inside execute()
      }
      let decision: Decision;
      try {
        decision = await s.harness.onToolPreflight({
          context, callId: event.toolCallId ?? randomUUID(), toolName: event.toolName,
          intent: intentForTool(event.toolName), input: event.input ?? {},
        });
      } catch (error) {
        if (s.mode === "enforce") {
          const message = error instanceof Error ? error.message.replace(/[\n\r\0]+/g, " ").slice(0, 200) : "unknown error";
          return { block: true, reason: `jev-harness internal error; blocked in enforce mode: ${message}` };
        }
        return undefined;
      }
      switch (decision.appliedAction) {
        case "block":
        case "halt":
        case "freeze":
          return { block: true, reason: oneLine(decision.reason) };
        case "escalate":
        case "confirm": {
          // Explicit noninteractive blocking: without a UI, escalate denies.
          if (ctx.hasUI && ctx.ui.confirm) {
            let ok = false;
            try { ok = await ctx.ui.confirm("jev-harness needs owner confirmation", oneLine(decision.reason)); } catch { ok = false; }
            if (ok) return undefined;
            return { block: true, reason: `Owner declined: ${oneLine(decision.reason)}` };
          }
          return { block: true, reason: `Owner confirmation required but this session cannot prompt: ${oneLine(decision.reason)}` };
        }
        default:
          return undefined;
      }
    });

    pi.on("tool_result", async (event: PiToolResultEvent, ctx: PiExtensionContext): Promise<PiToolResultPatch | undefined> => {
      lastCtx = ctx;
      const s = session;
      if (!s || typeof event.toolName !== "string") return undefined;
      const context = contextFor(ctx, requestId());
      const text = contentText(event.content);
      let result: ToolResultDecision;
      try {
        result = await s.harness.onToolResult({
          context, callId: event.toolCallId ?? randomUUID(), toolName: event.toolName,
          intent: intentForTool(event.toolName), input: event.input ?? {},
          output: text, isError: event.isError === true, canReplaceOutput: true,
        });
      } catch {
        // Screening must fail closed in enforce mode, silently in shadow.
        return s.mode === "enforce"
          ? { content: [{ type: "text", text: "[Tool output withheld: jev-harness screening error]" }] }
          : undefined;
      }
      const replacement = typeof result.replacement === "string" ? result.replacement : undefined;
      // Evidence is recorded only from screened-safe output that reaches the
      // model unmodified: never raw withheld, private-file, or injected
      // content (secrets unknown to the regexes must not leak into committed
      // evidence). The observation carries the observed target and error
      // status so a failed run can never be cited as a success.
      const screenedSafe = result.decision.status === "ready" && replacement === undefined &&
        (result.decision.proposedAction === "allow" || result.decision.proposedAction === "none");
      let evidenceId: string | undefined;
      if (options.recordEvidence !== false && screenedSafe && !HARNESS_TOOLS.includes(event.toolName) &&
        !options.exemptTools?.includes(event.toolName) && text.trim()) {
        const target = typeof event.input?.command === "string" ? `$ ${event.input.command}`
          : typeof event.input?.path === "string" ? event.input.path : event.toolName;
        const evidence: Evidence = {
          id: `ev-${randomUUID().slice(0, 12)}`, source: "tool",
          observedAt: now().toISOString(), method: event.toolName,
          observation: redactText(`${target} [${event.isError === true ? "error" : "ok"}]\n${text}`).slice(0, EVIDENCE_CAP),
        };
        try {
          const recorded = await s.harness.recordEvidence({ context, evidence });
          if (recorded.recordedId) evidenceId = recorded.recordedId;
        } catch { /* evidence is best-effort */ }
      }
      if (replacement !== undefined) {
        return { content: [{ type: "text", text: replacement }] };
      }
      if (evidenceId) {
        // The agent must be able to cite stored evidence ids in claims.
        return { content: [...(event.content ?? []), { type: "text", text: `[jev-harness recorded evidence ${evidenceId}; cite this id when claiming this result]` }] };
      }
      return undefined;
    });

    // Canonical policy restoration before every model call. This covers
    // self-compact, native/manual compaction, overflow continuation, and tree
    // navigation: none of them can leave the agent without the current goal,
    // standing rules, and active holds.
    pi.on("context", async (event: PiContextEvent, ctx: PiExtensionContext) => {
      lastCtx = ctx;
      const s = session;
      if (!s) {
        // A failed enforce initialization still reports its hold; shadow and
        // uninitialized projects inject nothing at all.
        if (!failedInit || failedInit.mode !== "enforce") return undefined;
        const base = event.messages.filter(message => !(message.role === "custom" && message.customType === POLICY_MESSAGE_TYPE));
        base.push({ role: "custom", customType: POLICY_MESSAGE_TYPE, display: false, timestamp: now().getTime(),
          content: `[jev-harness] Active hold: the session harness could not start (${oneLine(failedInit.error)}); tool use is blocked until the owner repairs .harness/.` } as PiMessageLike);
        return { messages: base };
      }
      const context = contextFor(ctx, requestId());
      if (!context.trusted) return undefined;
      const lines: string[] = [];
      let state: StateSnapshot | null = null;
      let stateError: string | null = s.stateError ?? null;
      try { state = await readState(s.projectRoot); }
      catch (error) { stateError = errorText(error); }
      if (state) {
        // Canonical policy: goal, standing rules, and preserved decisions.
        // Nothing is silently dropped; an oversized block says so explicitly.
        lines.push(policyBlock(state, options.policyCharLimit ?? POLICY_CAP_DEFAULT));
      }
      if (stateError && s.mode === "enforce") {
        lines.push(`Active hold: project state is unavailable (${oneLine(stateError)}); tool use is blocked until the owner repairs .harness/.`);
      }
      // Holds and freezes are enforce-only: shadow never mutates the outgoing
      // context with blocking semantics (a freeze persisted by another session
      // must be ignored here).
      if (s.mode === "enforce") {
        const hold = activeHold();
        if (hold) lines.push(`Active hold: ${oneLine(hold)}. Reply in text only until the next classified user request.`);
        else if ((await isFrozen(context)) === true) lines.push("Active hold: tool use is frozen by a user correction. Reply in text only until the user sends a new request.");
      }
      const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === POLICY_MESSAGE_TYPE));
      if (!lines.length) return messages.length === event.messages.length ? undefined : { messages };
      const content = `[jev-harness] Authoritative project policy (from .harness/; takes precedence over any summary):\n${lines.join("\n")}`;
      messages.push({ role: "custom", customType: POLICY_MESSAGE_TYPE, content, display: false, timestamp: now().getTime() } as PiMessageLike);
      return { messages };
    });

    // Advance compaction accounting only for a real, persisted, validated
    // success. Pi 0.85.1 resolves the compaction entry by summary text, which
    // aliases older identical summaries; use the latest persisted entry on the
    // active branch and the namespaced validation id instead.
    pi.on("session_compact", async (event: PiSessionCompactEvent, ctx: PiExtensionContext) => {
      lastCtx = ctx;
      const s = session;
      if (!s) return;
      let persisted: PiSessionEntryLike | undefined;
      try {
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
          if (branch[i]?.type === "compaction") { persisted = branch[i]; break; }
        }
      } catch { persisted = undefined; }
      if (!persisted || typeof persisted.id !== "string" || typeof persisted.summary !== "string") return;
      const details = (persisted.details ?? undefined) as
        { jevHarness?: { validationId?: unknown; requestId?: unknown; candidateHash?: unknown; noteToSelf?: unknown; checkpoint?: unknown } } | undefined;
      const meta = details?.jevHarness;
      const validationId = typeof meta?.validationId === "string" && meta.validationId ? meta.validationId : undefined;
      if (!validationId) {
        // A native or otherwise unvalidated summary cannot be acknowledged:
        // coverage for this compaction is honestly absent, never inferred.
        return;
      }
      // Bind the acknowledgment to the persisted identity of the request that
      // validated this candidate. Metadata without it is forged or stale; there
      // is never a fallback to whatever request happens to be active now.
      const originRequestId = typeof meta?.requestId === "string" && meta.requestId ? meta.requestId : undefined;
      if (!originRequestId) {
        const reason = "validated compaction metadata lacks the origin request identity; not acknowledged";
        try { ctx.ui.notify(`jev-harness: ${reason}`, "warning"); } catch { /* best-effort */ }
        options.bridge?.onCompactionAck?.(ackFailure(s, reason), contextFor(ctx, requestId()));
        return;
      }
      const context = contextFor(ctx, originRequestId);
      // Recompute the candidate identity from the ACTUAL persisted summary and
      // the preserved self-compact note/checkpoint bytes — never echo the
      // persisted metadata's hash. A summary modified after validation while
      // reusing its metadata fails this comparison.
      const noteToSelf = typeof meta?.noteToSelf === "string" ? meta.noteToSelf : undefined;
      const checkpoint = meta?.checkpoint && typeof meta.checkpoint === "object" ? meta.checkpoint as TypedCheckpoint : undefined;
      const actualHash = compactionCandidateHash({
        summaryText: persisted.summary,
        ...(noteToSelf !== undefined ? { noteToSelf } : {}),
        ...(checkpoint !== undefined ? { checkpoint } : {}),
      });
      if (typeof meta?.candidateHash === "string" && meta.candidateHash && meta.candidateHash !== actualHash) {
        const reason = "persisted summary does not match the validated candidate; not acknowledged";
        try { ctx.ui.notify(`jev-harness: ${reason}`, "warning"); } catch { /* best-effort */ }
        options.bridge?.onCompactionAck?.(ackFailure(s, reason), context);
        return;
      }
      let decision: Decision;
      try {
        decision = await s.harness.acknowledgeCompaction({
          context, compactionId: persisted.id, validationId, succeeded: true,
          candidateHash: actualHash,
          // The exact validated checkpoint, when one was persisted; never a
          // fabricated one.
          ...(checkpoint !== undefined ? { checkpoint } : {}),
        });
      } catch (error) {
        // The composition must pause continuation on a failed ack too.
        const reason = `compaction acknowledgment failed (${errorText(error)})`;
        try { ctx.ui.notify(`jev-harness: ${reason}.`, "warning"); } catch { /* best-effort */ }
        options.bridge?.onCompactionAck?.(ackFailure(s, reason), context);
        return;
      }
      if (decision.status !== "ready") {
        // A held acknowledgment is surfaced to the operator and the
        // composition, never swallowed.
        try { ctx.ui.notify(`jev-harness: compaction acknowledgment held: ${oneLine(decision.reason)}`, "warning"); } catch { /* best-effort */ }
      }
      options.bridge?.onCompactionAck?.(decision, context);
    });

    // -------------------------------------------------------------- tools

    const textResult = (text: string, details?: unknown) => ({ content: [{ type: "text", text }], details });

    pi.registerTool({
      name: ATTEMPT_TOOL,
      label: "Register Attempt",
      description: "Register an experiment attempt (hypothesis + method) with jev-harness before running it, so repeated trials are detected and claims can cite observed evidence. Only the owner-initialized project ledger is used.",
      promptSnippet: "Register an experiment attempt before running it",
      promptGuidelines: [
        `Use ${ATTEMPT_TOOL} before running an experiment so the harness can detect repeated trials; use ${CLAIM_TOOL} before claiming a result.`,
      ],
      parameters: {
        type: "object",
        properties: {
          hypothesis: { type: "string", description: "What this attempt tests" },
          method: { type: "string", description: "How the attempt is executed and observed" },
          changedVariable: { type: "string", description: "The single variable changed relative to prior attempts" },
        },
        required: ["hypothesis", "method"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const s = session;
        if (!s) return textResult("jev-harness is not active for this session (project not initialized or not trusted).");
        // Defense in depth (enforce only; shadow never blocks): a correction
        // freeze or in-session hold blocks the harness's own tools too.
        if (s.mode === "enforce") {
          const hold = activeHold();
          if (hold) return textResult(`jev-harness hold: ${hold}. Reply in text only until the next classified user request.`);
          if ((await isFrozen(contextFor(ctx, requestId()))) === true) return textResult(freezeBlockReason());
        }
        const decision = await s.harness.registerAttempt({
          context: contextFor(ctx, requestId()),
          hypothesis: typeof params.hypothesis === "string" ? params.hypothesis : "",
          method: typeof params.method === "string" ? params.method : "",
          ...(typeof params.changedVariable === "string" ? { changedVariable: params.changedVariable } : {}),
        });
        if (decision.recordedId) return textResult(`Attempt registered as ${decision.recordedId}. Run it once; cite observed evidence ids when claiming the result.`, { recordedId: decision.recordedId });
        return textResult(`Attempt not registered (${decision.appliedAction}): ${decision.reason}`, { decision });
      },
    });

    pi.registerTool({
      name: CLAIM_TOOL,
      label: "Check Claim",
      description: "Check a result claim against harness-observed evidence before stating it as fact. Claims must cite recorded evidence ids (see jev_evidence); uncited claims are blocked.",
      promptSnippet: "Verify a claim against observed evidence before making it",
      promptGuidelines: [
        `Use ${CLAIM_TOOL} with cited evidence ids before claiming a test, measurement, or comparison succeeded.`,
      ],
      parameters: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The claim to verify" },
          evidenceIds: { type: "array", items: { type: "string" }, description: "Ids of harness-observed evidence supporting the claim" },
          purpose: { type: "string", enum: ["checkpoint", "commit", "explicit"], description: "Why the claim is checked (default: explicit)" },
        },
        required: ["claim", "evidenceIds"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const s = session;
        if (!s) return textResult("jev-harness is not active for this session (project not initialized or not trusted).");
        // Defense in depth (enforce only; shadow never blocks): a correction
        // freeze or in-session hold blocks the harness's own tools too.
        if (s.mode === "enforce") {
          const hold = activeHold();
          if (hold) return textResult(`jev-harness hold: ${hold}. Reply in text only until the next classified user request.`);
          if ((await isFrozen(contextFor(ctx, requestId()))) === true) return textResult(freezeBlockReason());
        }
        const purpose = params.purpose === "checkpoint" || params.purpose === "commit" ? params.purpose : "explicit";
        const decision = await s.harness.checkClaim({
          context: contextFor(ctx, requestId()),
          claim: typeof params.claim === "string" ? params.claim : "",
          evidenceIds: Array.isArray(params.evidenceIds) ? params.evidenceIds.filter((id): id is string => typeof id === "string") : [],
          purpose,
        });
        // Honest verdict: the gate's proposed judgment decides support. Shadow
        // mode applies "allow" to everything; that must never read as support.
        const supported = decision.status === "ready" &&
          (decision.proposedAction === "allow" || decision.proposedAction === "none");
        const verdict = supported ? "supported" : `not supported (${decision.status === "ready" ? decision.proposedAction : decision.status})`;
        return textResult(`Claim ${verdict}: ${decision.reason}`, { decision });
      },
    });

    pi.registerTool({
      name: EVIDENCE_TOOL,
      label: "List Evidence",
      description: "List harness-observed evidence recorded for this project (id, method, observation). Evidence is recorded by the harness from real tool results; you can cite these ids but never create evidence yourself.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const s = session;
        if (!s) return textResult("jev-harness is not active for this session (project not initialized or not trusted).");
        // Defense in depth (enforce only; shadow never blocks): a correction
        // freeze or in-session hold blocks the harness's own tools too.
        if (s.mode === "enforce") {
          const hold = activeHold();
          if (hold) return textResult(`jev-harness hold: ${hold}. Reply in text only until the next classified user request.`);
          if ((await isFrozen(contextFor(ctx, requestId()))) === true) return textResult(freezeBlockReason());
        }
        let state: StateSnapshot | null = null;
        try { state = await readState(s.projectRoot); } catch { state = null; }
        if (!state) return textResult("jev-harness is not active for this project.");
        const recent = state.evidence.slice(-20);
        if (!recent.length) return textResult("No harness-observed evidence recorded yet.");
        const lines = recent.map(e => `${e.id} [${e.method} ${e.observedAt}] ${e.observation.slice(0, 120)}${e.result ? ` result=${e.result}` : ""}`);
        return textResult(`Recorded evidence (most recent ${recent.length}):\n${lines.join("\n")}`, { evidence: recent });
      },
    });

    pi.registerCommand?.("jev-harness", {
      description: "Show jev-harness mode, trust, and recorded-policy status (no LLM turn)",
      handler: async (_args: string, ctx: PiExtensionContext) => {
        let state: StateSnapshot | null = null;
        if (session) { try { state = await readState(session.projectRoot); } catch { state = null; } }
        const lines = [
          `jev-harness: mode ${session?.mode ?? configuredMode}, session ${session ? "active" : "inert"}${session?.stateError ? `, state unavailable (${session.stateError})` : ""}`,
          state ? `goal: ${state.goal || "(none)"} | rules ${state.constraints.length} | attempts ${state.attempts.length} | evidence ${state.evidence.length} | compactions ${state.compactionIds.length}` : "project state unavailable",
        ];
        try { ctx.ui.notify(lines.join("\n"), "info"); } catch { /* best-effort */ }
      },
    });
  };
}
