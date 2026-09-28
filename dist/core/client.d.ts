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
/** Closed set of provider failure categories; every member maps to a fixed,
 * credential-free diagnostic string. Unknown errors never get one. */
export type ProviderFailureCode = "missing-api-key" | "request-cancelled" | "request-timeout" | "http-error" | "invalid-response" | "request-too-large" | "transport-failed";
export declare class ProviderUnavailableError extends Error {
    readonly code: ProviderFailureCode;
    /** Controlled token only (an env var name, an HTTP status number, or a
     * bounded timeout in ms), never free-form text, a caught message, a body,
     * a payload, or a header. */
    readonly detail?: string;
    /** False for the legacy single-message form; unstructured errors always
     * format to the generic diagnostic. */
    readonly structured: boolean;
    constructor(message: string);
    constructor(code: ProviderFailureCode, message: string, detail?: string);
}
/** Safe diagnostic for a failed provider call, suitable for decisions and
 * audit. Only closed codes are expanded; anything else (including arbitrary
 * caught error messages, which may echo attacker-controlled text or keys)
 * collapses to the generic phrase. */
export declare function providerFailureReason(error: unknown): string;
export declare function createJevClient(options?: JevClientOptions): DecisionProvider;
