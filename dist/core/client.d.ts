import type { DecisionProvider } from "./contracts.js";
export type JevTransport = "typesafe" | "openrouter";
export interface JevClientOptions {
    readonly transport?: JevTransport;
    readonly apiKey?: string;
    readonly model?: string;
    readonly endpoint?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetcher?: typeof fetch;
    readonly timeoutMs?: number;
    readonly maxRequestBytes?: number;
    readonly allowInsecureLocalForTests?: boolean;
}
export declare class ProviderUnavailableError extends Error {
    constructor(message: string);
}
export declare function createJevClient(options?: JevClientOptions): DecisionProvider;
