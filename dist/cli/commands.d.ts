import type { Decision } from "../core/contracts.js";
export interface Parsed {
    /** Positional tokens, e.g. ["check", "shell", "npm", "install"]. */
    readonly args: readonly string[];
    readonly flags: Readonly<Record<string, string | boolean>>;
    /** Tokens after a literal `--`. */
    readonly rest: readonly string[];
}
export interface CliEnv {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly execPath: string;
    /** Absolute path of the running dist/cli.js, used in installed hook commands. */
    readonly cliPath: string;
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    readonly readStdin: () => Promise<string>;
}
export declare const EXIT: {
    readonly ok: 0;
    readonly failure: 1;
    readonly blocked: 2;
    readonly usage: 64;
};
export declare class UsageError extends Error {
}
/** 0 allowed · 2 blocked/escalated · 1 inert or unavailable (nothing was verified). */
export declare function exitForDecision(decision: Decision): number;
export declare function formatDecision(decision: Decision): string;
export declare function runCommand(parsed: Parsed, io: CliEnv): Promise<number>;
