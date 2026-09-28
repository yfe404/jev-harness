import { redactValue } from "./redact.js";
/** Closed detail whitelist: the only values providerFailureReason will ever
 * interpolate. Anything else collapses to a generic diagnostic. */
const API_KEY_DETAILS = new Set(["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY or OPENROUTER_API_KEY"]);
const validHttpStatus = (d) => !!d && /^[0-9]+$/.test(d) && Number(d) >= 100 && Number(d) <= 599;
const validBoundedMs = (d) => !!d && /^[0-9]+$/.test(d) && Number(d) >= 1 && Number(d) <= 60_000;
export class ProviderUnavailableError extends Error {
    code;
    /** Controlled token only (an env var name, an HTTP status number, or a
     * bounded timeout in ms), never free-form text, a caught message, a body,
     * a payload, or a header. */
    detail;
    /** False for the legacy single-message form; unstructured errors always
     * format to the generic diagnostic. */
    structured;
    constructor(codeOrMessage, message, detail) {
        super(message === undefined ? codeOrMessage : message);
        this.name = "ProviderUnavailableError";
        if (message === undefined) {
            this.code = "transport-failed";
            this.structured = false;
        }
        else {
            this.code = codeOrMessage;
            this.structured = true;
            if (detail !== undefined)
                this.detail = detail;
        }
    }
}
/** Safe diagnostic for a failed provider call, suitable for decisions and
 * audit. Only closed codes are expanded; anything else (including arbitrary
 * caught error messages, which may echo attacker-controlled text or keys)
 * collapses to the generic phrase. */
export function providerFailureReason(error) {
    if (!(error instanceof ProviderUnavailableError) || !error.structured)
        return "Jev verdict is unavailable or invalid";
    switch (error.code) {
        case "missing-api-key":
            if (!API_KEY_DETAILS.has(error.detail ?? ""))
                return "Jev verdict is unavailable or invalid";
            return `Jev API key is not configured: export ${error.detail} and restart Pi with the key in its environment (no provider request was sent)`;
        case "http-error":
            if (!validHttpStatus(error.detail))
                return "Jev verdict is unavailable or invalid";
            return `Jev provider rejected the request with HTTP ${error.detail}; check the configured API key and provider status`;
        case "request-timeout":
            if (!validBoundedMs(error.detail))
                return "Jev provider did not respond before the configured timeout";
            return `Jev provider did not respond within the configured ${error.detail} ms timeout`;
        case "request-cancelled":
            return "Jev request was cancelled before a verdict arrived";
        case "invalid-response":
            return "Jev provider returned an invalid or incomplete verdict";
        case "request-too-large":
            return "Jev request exceeds the provider request size limit";
        case "transport-failed":
            return "Jev transport failed or returned unreadable data";
        default:
            return "Jev verdict is unavailable or invalid";
    }
}
export function createJevClient(options = {}) {
    const env = options.env ?? process.env;
    const transport = options.transport ?? (env.TYPESAFE_API_KEY ? "typesafe" : env.OPENROUTER_API_KEY ? "openrouter" : "typesafe");
    if (transport !== "typesafe" && transport !== "openrouter")
        throw new Error("Unknown Jev transport");
    const apiKey = options.apiKey ?? (transport === "typesafe" ? env.TYPESAFE_API_KEY : env.OPENROUTER_API_KEY);
    const model = options.model ?? (transport === "typesafe" ? "jev-latest" : "typesafe/jev-1.13");
    const endpoint = options.endpoint ?? (transport === "typesafe"
        ? "https://api.typesafe.ai/v1/systemone"
        : "https://openrouter.ai/api/alpha/decisions");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(options.allowInsecureLocalForTests && url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        throw new Error("Jev endpoint must use HTTPS");
    if (url.username || url.password || url.hash)
        throw new Error("Jev endpoint must not contain credentials or fragments");
    const envTimeout = env.JH_TIMEOUT_MS;
    const timeoutMs = options.timeoutMs ?? (envTimeout === undefined ? 15_000 : Number(envTimeout));
    const maxRequestBytes = options.maxRequestBytes ?? 24_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
        throw new Error("Invalid Jev timeout");
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 256_000)
        throw new Error("Invalid Jev request bound");
    const fetcher = options.fetcher ?? fetch;
    return {
        async decide(request, signal) {
            const auto = options.transport === undefined;
            const keyName = auto && !apiKey ? "TYPESAFE_API_KEY or OPENROUTER_API_KEY"
                : transport === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
            if (!apiKey)
                throw new ProviderUnavailableError("missing-api-key", `Set ${keyName}`, keyName);
            if (signal?.aborted)
                throw new ProviderUnavailableError("request-cancelled", "Jev request cancelled");
            const state = redactValue(request.state, maxRequestBytes);
            const questions = redactValue(request.questions, maxRequestBytes);
            const body = JSON.stringify({ model, state, questions });
            if (Buffer.byteLength(body) > maxRequestBytes)
                throw new ProviderUnavailableError("request-too-large", "Jev request exceeds size limit");
            const controller = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
            const parentAbort = () => controller.abort();
            signal?.addEventListener("abort", parentAbort, { once: true });
            const aborted = new Promise((_resolve, reject) => {
                controller.signal.addEventListener("abort", () => reject(timedOut
                    ? new ProviderUnavailableError("request-timeout", "Jev request timed out", String(timeoutMs))
                    : new ProviderUnavailableError("request-cancelled", "Jev request cancelled")), { once: true });
            });
            try {
                const response = await Promise.race([
                    fetcher(url, {
                        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
                        body, signal: controller.signal,
                    }), aborted,
                ]);
                if (!response.ok)
                    throw new ProviderUnavailableError("http-error", `Jev HTTP ${response.status}`, String(response.status));
                const text = await Promise.race([boundedBody(response, 64_000), aborted]);
                let parsed;
                try {
                    parsed = JSON.parse(text);
                }
                catch {
                    throw new ProviderUnavailableError("invalid-response", "Jev response is invalid JSON");
                }
                if (!parsed || typeof parsed !== "object" || !("answers" in parsed))
                    throw new ProviderUnavailableError("invalid-response", "Jev response is missing answers");
                return parsed;
            }
            catch (error) {
                if (error instanceof ProviderUnavailableError)
                    throw error;
                throw new ProviderUnavailableError("transport-failed", "Jev transport failed or returned invalid data");
            }
            finally {
                clearTimeout(timer);
                signal?.removeEventListener("abort", parentAbort);
            }
        },
    };
}
async function boundedBody(response, maxBytes) {
    if (!response.body)
        throw new Error("Empty Jev response");
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > maxBytes)
                throw new Error("Jev response exceeds size limit");
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
