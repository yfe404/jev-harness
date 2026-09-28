// In-memory services shared by core, hook, CLI, and Pi contract tests.
// No credentials, filesystem writes, or network calls.
export function context(overrides = {}) {
  return {
    host: 'cli', projectRoot: '/example', sessionId: 'session-1',
    requestId: 'request-1', trusted: true, ...overrides,
  };
}

export function snapshot(overrides = {}) {
  return {
    revision: '1', goal: 'Make the sample app greet the user.', constraints: [],
    attempts: [], evidence: [], summary: null, compactionIds: [], ...overrides,
  };
}

export function fixtureServices({ initialized = true, initial = snapshot(), reply, auditFails = false } = {}) {
  let current = initialized ? structuredClone(initial) : null;
  const auditEntries = [];
  const requests = [];
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
        if (mutation.kind === 'checkpoint') next.summary = mutation.checkpoint;
        if (mutation.kind === 'compaction-ack' && !next.compactionIds.includes(mutation.compactionId)) next.compactionIds.push(mutation.compactionId);
        next.revision = String(Number(next.revision) + 1);
        current = next;
        return structuredClone(next);
      },
    },
    audit: {
      async append(entry) {
        if (auditFails) throw new Error('audit unavailable');
        auditEntries.push(structuredClone(entry));
      },
    },
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  };
  return { services, auditEntries, requests, getState: () => current === null ? null : structuredClone(current) };
}
