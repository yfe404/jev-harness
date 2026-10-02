// Pi adapter entry point. The default export is the extension factory Pi
// loads (package.json "pi.extensions"); createPiHarnessExtension is the
// injectable seam used by tests and by the AGI composition wrapper.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHarness } from "../../core/harness.js";
import { createJevClient } from "../../core/client.js";
import { createFileStateService } from "../../core/state/files.js";
import { createFileRuntimeService } from "../../core/state/locks.js";
import { createFileAuditService } from "../../core/report.js";
import { findProjectRoot, parseMode, readConfig } from "../../cli/config.js";
import { createPiHarnessExtension } from "./extension.js";
export { createPiHarnessExtension } from "./extension.js";
export { ATTEMPT_TOOL, CLAIM_TOOL, EVIDENCE_TOOL, POLICY_MESSAGE_TYPE, REQUEST_ENTRY_TYPE, } from "./extension.js";
export { intentForTool, contentText } from "./types.js";
/**
 * Production wiring: real file services and the Jev client. Nothing runs
 * until a session starts in a trusted, explicitly initialized project.
 * Mode resolution mirrors the CLI per session: JH_MODE overrides
 * .harness/config.json at the nearest initialized root (JEV_HARNESS_MODE is a
 * deprecated alias); without either, projects stay in shadow mode.
 */
export function createDefaultPiHarnessOptions(env = process.env) {
    const envMode = env.JH_MODE?.trim()
        ? parseMode(env.JH_MODE, "JH_MODE")
        : env.JEV_HARNESS_MODE?.trim()
            ? parseMode(env.JEV_HARNESS_MODE, "JEV_HARNESS_MODE (deprecated; use JH_MODE)")
            : undefined;
    const runtime = createFileRuntimeService();
    return {
        mode: envMode ?? "shadow",
        runtime,
        findProjectRoot: async (start) => {
            // A symlinked .harness at the session directory is invalid state, never
            // a reason to adopt an ancestor's project: surface it as corruption
            // (blocked in enforce) instead of bypassing it via the parent walk.
            try {
                const info = await lstat(join(start, ".harness"));
                if (info.isSymbolicLink())
                    throw new Error(".harness must be a real directory, not a symbolic link");
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            return findProjectRoot(start);
        },
        resolveMode: async (context) => {
            if (envMode)
                return envMode;
            return (await readConfig(context.projectRoot, {})).mode;
        },
        createHarnessForSession: (context, mode) => createHarness({
            provider: createJevClient({ env }),
            state: createFileStateService(),
            runtime,
            audit: createFileAuditService(context),
        }, { mode, allowExternalReads: env.JH_ALLOW_EXTERNAL_READS === "1" }),
    };
}
export default function jevHarnessPi(pi) {
    createPiHarnessExtension(createDefaultPiHarnessOptions())(pi);
}
