export type InstallScope = "user" | "project" | "local";
export interface InstallerPaths {
    readonly nodePath: string;
    readonly cliPath: string;
}
export interface InstallReport {
    readonly file: string;
    readonly action: "installed" | "unchanged" | "uninstalled" | "absent";
    readonly backup?: string;
    readonly warnings: readonly string[];
}
export interface HookStatusEntry {
    readonly event: string;
    readonly installed: boolean;
    readonly command?: string;
}
export interface HookStatusReport {
    readonly file: string;
    readonly exists: boolean;
    readonly events: readonly HookStatusEntry[];
}
export declare const HOOK_TIMEOUT_SECONDS = 15;
/** One dispatcher command per event; identical commands are deduplicated by the host. */
export declare const CLAUDE_HOOK_EVENTS: ReadonlyArray<{
    readonly event: string;
    readonly matcher?: string;
}>;
/** POSIX single-quote escaping for paths with spaces; rejects control characters. */
export declare function quotePosix(value: string): string;
/** Fixed argv; no agent-controlled content is ever spliced into this string. */
export declare function hookCommand(paths: InstallerPaths): string;
/** Conservative ownership: our dispatcher command, possibly installed from an older path. */
export declare function isJevHookEntry(entry: unknown): boolean;
/** The printable fragment: what `jh install claude --print` shows. */
export declare function buildSettingsFragment(paths: InstallerPaths): Record<string, unknown>;
/**
 * Pure merge of our entries into parsed settings. Throws on structures we refuse
 * to guess at. Returns changed=false when every entry is already current.
 */
export declare function mergeHooks(existing: Record<string, unknown>, command: string): {
    settings: Record<string, unknown>;
    changed: boolean;
};
/** Pure removal of our entries; drops only groups/keys emptied by that removal. */
export declare function removeHooks(existing: Record<string, unknown>): {
    settings: Record<string, unknown>;
    changed: boolean;
};
export declare function settingsPathFor(scope: InstallScope, options: {
    projectRoot: string;
    homeDir: string;
}): string;
export interface InstallOptions {
    readonly scope: InstallScope;
    readonly projectRoot: string;
    readonly homeDir: string;
    readonly paths: InstallerPaths;
}
export declare function installClaudeHooks(options: InstallOptions): Promise<InstallReport>;
export declare function uninstallClaudeHooks(options: Omit<InstallOptions, "paths">): Promise<InstallReport>;
export declare function claudeHookStatus(options: Omit<InstallOptions, "paths">): Promise<HookStatusReport>;
