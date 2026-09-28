// In-memory services shared by core, hook, CLI, and Pi contract tests.
// No credentials, filesystem writes, or network calls.
import { createHash } from 'node:crypto';

// Mirrors src/core/compaction.ts targetEvidenceMark: only confirmed/refuted
// observations move the mark; inconclusive evidence and setup failures never do.
function targetEvidenceMark(state) {
  const ids = state.evidence
    .filter(e => e.source === 'harness' && (e.result === 'confirmed' || e.result === 'refuted'))
    .map(e => e.id).sort();
  return createHash('sha256').update(ids.join('\n')).digest('hex');
}

export function context(overrides = {}) {
  return {
    host: 'cli', projectRoot: '/example', sessionId: 'session-1',
    requestId: 'request-1', trusted: true, ...overrides,
  };
}

export function snapshot(overrides = {}) {
  return {
    revision: '1', goal: 'Make the sample app greet the user.', constraints: [],
    attempts: [], evidence: [], summary: null, compactionIds: [], compactionCycles: [], checkpointAcks: [], ...overrides,
  };
}

export function fixtureServices({ initialized = true, initial = snapshot(), reply, auditFails = false } = {}) {
  let current = initialized ? structuredClone(initial) : null;
  const auditEntries = [];
  const requests = [];
  const requestStates = new Map();
  const sessionFreeze = new Map();
  const accepted = new Map();
  const compactionValidations = new Map();
  const compactionRegistry = {
    async save(record) {
      if (compactionValidations.has(record.validationId)) throw new Error('duplicate validation id');
      compactionValidations.set(record.validationId, { record: structuredClone(record) });
    },
    async get(validationId) {
      const found = compactionValidations.get(validationId);
      return found ? structuredClone(found) : null;
    },
    async acknowledge(validationId, compactionId) {
      const found = compactionValidations.get(validationId);
      if (!found) throw new Error('unknown validation id');
      if (found.compactionId !== undefined) {
        if (found.compactionId === compactionId) return;
        throw new Error('validation consumed by a different compaction');
      }
      for (const [id, entry] of compactionValidations)
        if (entry.compactionId === compactionId) throw new Error(`compaction already acknowledged under a different validation ${id}`);
      found.compactionId = compactionId;
    },
    async lookupCompaction(compactionId) {
      for (const [id, entry] of compactionValidations) if (entry.compactionId === compactionId) return id;
      return null;
    },
  };
  const getRequest = (ctx) => requestStates.get(`${ctx.sessionId}:${ctx.requestId}`) ?? { frozen: false, planReviewed: false };
  const services = {
    provider: {
      async decide(request, signal) {
        requests.push(request);
        if (signal?.aborted) throw signal.reason;
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply(request) : (reply ?? { answers: {} });
      },
    },
    state: {
      async read() { return current === null ? null : structuredClone(current); },
      async write(_context, expectedRevision, mutation) {
        if (!current || current.revision !== expectedRevision) throw new Error('revision conflict');
        const next = structuredClone(current);
        if (mutation.kind === 'constraint') next.constraints.push(mutation.constraint);
        if (mutation.kind === 'attempt') next.attempts.push(mutation.attempt);
        if (mutation.kind === 'evidence') next.evidence.push(mutation.evidence);
        if (mutation.kind === 'attempt-result') {
          const a = next.attempts.find(item => item.id === mutation.attemptId);
          if (!a) throw new Error('unknown attempt');
          Object.assign(a, { result: mutation.result, evidenceIds: mutation.evidenceIds, countsAsTrial: mutation.result !== 'setup_failure' });
        }
        if (mutation.kind === 'checkpoint') {
          if (mutation.appliedValidationId !== undefined && (next.checkpointAcks ?? []).includes(mutation.appliedValidationId)) return structuredClone(next);
          next.summary = mutation.checkpoint;
          if (mutation.appliedValidationId !== undefined) next.checkpointAcks = [...(next.checkpointAcks ?? []), mutation.appliedValidationId];
        }
        if (mutation.kind === 'compaction-ack') {
          // Atomic application, mirroring the file service: counter/cycle, merged
          // checkpoint, and the durable application marker in one write; a replay
          // whose marker is already recorded is a pure no-op.
          const priorAcks = next.checkpointAcks ?? [];
          if (priorAcks.includes(mutation.validationId)) return structuredClone(next);
          if (mutation.countEvidence !== false && !next.compactionIds.includes(mutation.compactionId)) {
            next.compactionIds.push(mutation.compactionId);
            next.compactionCycles = [...(next.compactionCycles ?? next.compactionIds.slice(0, -1).map(id => ({ id, evidence: null }))),
              { id: mutation.compactionId, evidence: targetEvidenceMark(current) }];
          }
          if (mutation.checkpoint !== undefined) next.summary = mutation.checkpoint;
          next.checkpointAcks = [...priorAcks, mutation.validationId];
        }
        next.revision = String(Number(next.revision) + 1);
        current = next;
        return structuredClone(next);
      },
    },
    runtime: {
      async get(ctx) { return { ...structuredClone(getRequest(ctx)), frozen: getRequest(ctx).frozen || sessionFreeze.has(ctx.sessionId) }; },
      async accept(ctx) {
        const seen = accepted.get(ctx.sessionId) ?? new Set();
        if (seen.has(ctx.requestId)) return { fresh: false, releasedPriorFreeze: false };
        seen.add(ctx.requestId);
        accepted.set(ctx.sessionId, seen);
        const releasedPriorFreeze = sessionFreeze.has(ctx.sessionId) && sessionFreeze.get(ctx.sessionId) !== ctx.requestId;
        if (releasedPriorFreeze) sessionFreeze.delete(ctx.sessionId);
        return { fresh: true, releasedPriorFreeze };
      },
      async freeze(ctx) {
        const seen = accepted.get(ctx.sessionId);
        if (seen?.has(ctx.requestId) && [...seen].at(-1) !== ctx.requestId) return;
        sessionFreeze.set(ctx.sessionId, ctx.requestId);
        requestStates.set(`${ctx.sessionId}:${ctx.requestId}`, { ...getRequest(ctx), frozen: true });
      },
      async clear(ctx) {
        if (sessionFreeze.get(ctx.sessionId) === ctx.requestId) sessionFreeze.delete(ctx.sessionId);
        requestStates.set(`${ctx.sessionId}:${ctx.requestId}`, { ...getRequest(ctx), frozen: false });
      },
      async markPlanReviewed(ctx) { requestStates.set(`${ctx.sessionId}:${ctx.requestId}`, { ...getRequest(ctx), planReviewed: true }); },
    },
    audit: {
      async append(entry) {
        if (auditFails) throw new Error('audit unavailable');
        auditEntries.push(structuredClone(entry));
      },
    },
    compactionRegistry,
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  };
  return { services, auditEntries, requests, compactionValidations,
    clearFreeze(ctx) {
      if (sessionFreeze.get(ctx.sessionId) === ctx.requestId) sessionFreeze.delete(ctx.sessionId);
      requestStates.set(`${ctx.sessionId}:${ctx.requestId}`, { ...getRequest(ctx), frozen: false });
    },
    getState: () => current === null ? null : structuredClone(current) };
}
