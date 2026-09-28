import { type PiHarnessOptions } from "./extension.js";
import type { PiExtensionApi } from "./types.js";
export { createPiHarnessExtension } from "./extension.js";
export type { PiHarnessBridge, PiHarnessOptions } from "./extension.js";
export { ATTEMPT_TOOL, CLAIM_TOOL, EVIDENCE_TOOL, POLICY_MESSAGE_TYPE, REQUEST_ENTRY_TYPE, } from "./extension.js";
export { intentForTool, contentText } from "./types.js";
export type { PiBeforeAgentStartEvent, PiContextEvent, PiExtensionApi, PiExtensionContext, PiInputEvent, PiMessageLike, PiSessionCompactEvent, PiSessionEntryLike, PiToolCallEvent, PiToolResultEvent, } from "./types.js";
/**
 * Production wiring: real file services and the Jev client. Nothing runs
 * until a session starts in a trusted, explicitly initialized project.
 * Mode resolution mirrors the CLI per session: JH_MODE overrides
 * .harness/config.json at the nearest initialized root (JEV_HARNESS_MODE is a
 * deprecated alias); without either, projects stay in shadow mode.
 */
export declare function createDefaultPiHarnessOptions(env?: Readonly<Record<string, string | undefined>>): PiHarnessOptions;
export default function jevHarnessPi(pi: PiExtensionApi): void;
