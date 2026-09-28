// Shared wiring for CLI commands: build a Harness over the file-backed services
// for one project root, with either the live Jev client or an offline replay
// provider (`--replay <file>` or JH_REPLAY). The CLI never fabricates a verdict:
// without a reachable provider every gate decision is `unavailable`.
import { randomUUID } from "node:crypto";
import type { EventContext, Harness, Host, Mode } from "../core/contracts.js";
import { createHarness } from "../core/harness.js";
import { createJevClient } from "../core/client.js";
import { createFileStateService } from "../core/state/files.js";
import { createFileRuntimeService } from "../core/state/locks.js";
import { createFileAuditService } from "../core/report.js";
import { readConfig } from "./config.js";
import { createReplayProvider, loadReplayRules } from "./replay.js";

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

export async function wireHarness(options: WireOptions): Promise<Wiring> {
  const env = options.env ?? process.env;
  const mode = (await readConfig(options.root, env)).mode;
  const context: EventContext = {
    host: options.host,
    projectRoot: options.root,
    // JH_SESSION_ID/JH_REQUEST_ID let separate CLI invocations share one
    // identity; compaction acknowledgment requires the same session/request
    // as its validation. Host hooks supply their own stable ids instead.
    sessionId: options.sessionId ?? env.JH_SESSION_ID ?? `cli-${randomUUID()}`,
    requestId: options.requestId ?? env.JH_REQUEST_ID ?? `req-${randomUUID()}`,
    trusted: true,
  };
  const replayPath = options.replay ?? env.JH_REPLAY?.trim() ?? undefined;
  const provider = replayPath ? createReplayProvider(loadReplayRules(replayPath)) : createJevClient({ env });
  const harness = createHarness({
    provider,
    state: createFileStateService(),
    runtime: createFileRuntimeService(),
    audit: createFileAuditService(context),
  }, { mode });
  return { root: options.root, mode, context, harness, providerKind: replayPath ? "replay" : "live" };
}
