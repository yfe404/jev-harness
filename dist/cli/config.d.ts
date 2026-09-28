import type { Mode } from "../core/contracts.js";
/** Owner-edited project settings. Lives next to the state it governs and is committed with it. */
export interface ProjectConfig {
    readonly mode: Mode;
}
export interface ResolvedConfig extends ProjectConfig {
    readonly source: "env" | "file" | "default";
}
export declare const CONFIG_FILE = "config.json";
export declare function parseMode(value: string | undefined, label?: string): Mode;
/** Walk up from `start` to the nearest directory holding a real `.harness/` directory. */
export declare function findProjectRoot(start: string): Promise<string | null>;
export declare function isInitialized(root: string): Promise<boolean>;
/** `JH_MODE` overrides `.harness/config.json`; otherwise projects stay in shadow mode. Invalid config throws. */
export declare function readConfig(root: string, env?: Readonly<Record<string, string | undefined>>): Promise<ResolvedConfig>;
export declare function writeConfig(root: string, config: ProjectConfig): Promise<string>;
/** Temporary file in the same directory, fsync, rename. Never follows a symlink at the destination. */
export declare function writeAtomic(path: string, content: string, mode?: number): Promise<void>;
