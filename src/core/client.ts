import type { DecisionProvider, ProviderRequest } from "./contracts.js";
import { redactValue } from "./redact.js";

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
export class ProviderUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderUnavailableError"; }
}

export function createJevClient(options: JevClientOptions = {}): DecisionProvider {
  const env = options.env ?? process.env;
  const transport = options.transport ?? (env.TYPESAFE_API_KEY ? "typesafe" : env.OPENROUTER_API_KEY ? "openrouter" : "typesafe");
  if (transport !== "typesafe" && transport !== "openrouter") throw new Error("Unknown Jev transport");
  const apiKey = options.apiKey ?? (transport === "typesafe" ? env.TYPESAFE_API_KEY : env.OPENROUTER_API_KEY);
  const model = options.model ?? (transport === "typesafe" ? "jev-latest" : "typesafe/jev-1.13");
  const endpoint = options.endpoint ?? (transport === "typesafe"
    ? "https://api.typesafe.ai/v1/systemone"
    : "https://openrouter.ai/api/alpha/decisions");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(options.allowInsecureLocalForTests && url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Jev endpoint must use HTTPS");
  if (url.username || url.password || url.hash) throw new Error("Jev endpoint must not contain credentials or fragments");
  const timeoutMs = options.timeoutMs ?? 4_000;
  const maxRequestBytes = options.maxRequestBytes ?? 24_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid Jev timeout");
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 256_000) throw new Error("Invalid Jev request bound");
  const fetcher = options.fetcher ?? fetch;
  return {
    async decide(request: ProviderRequest, signal?: AbortSignal): Promise<unknown> {
      if (!apiKey) throw new ProviderUnavailableError(`Set ${transport === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY"}`);
      if (signal?.aborted) throw new ProviderUnavailableError("Jev request cancelled");
      const state = redactValue(request.state, maxRequestBytes);
      const questions = redactValue(request.questions, maxRequestBytes);
      const body = JSON.stringify({ model, state, questions });
      if (Buffer.byteLength(body) > maxRequestBytes) throw new ProviderUnavailableError("Jev request exceeds size limit");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const parentAbort = () => controller.abort();
      signal?.addEventListener("abort", parentAbort, { once: true });
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new ProviderUnavailableError("Jev request cancelled or timed out")), { once: true });
      });
      try {
        const response = await Promise.race([
          fetcher(url, {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body, signal: controller.signal,
          }), aborted,
        ]);
        if (!response.ok) throw new ProviderUnavailableError(`Jev HTTP ${response.status}`);
        const text = await Promise.race([boundedBody(response, 64_000), aborted]);
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new ProviderUnavailableError("Jev response is invalid JSON"); }
        if (!parsed || typeof parsed !== "object" || !("answers" in parsed)) throw new ProviderUnavailableError("Jev response is missing answers");
        return parsed;
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw error;
        throw new ProviderUnavailableError("Jev transport failed or returned invalid data");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", parentAbort);
      }
    },
  };
}

async function boundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("Empty Jev response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Jev response exceeds size limit");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
