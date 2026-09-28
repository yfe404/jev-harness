import { basename, normalize } from "node:path";
/** Known credential shapes only. Callers must still exclude private files by path. */
const secrets = [
    /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\b(?:AIza)[A-Za-z0-9_-]{30,}\b/g,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:api[_-]?key|password|access[_-]?token|secret|cookie)\s*[:=]\s*["']?[^\s,;"']{8,}/gi,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
];
const placeholder = /\b(?:api[_-]?key|password|access[_-]?token|secret|cookie)\s*[:=]\s*["']?(?:YOUR_[A-Z_]+|REPLACE_ME|CHANGEME|placeholder|example|test-key)["']?\b/gi;
function markPlaceholders(value) { return value.replace(placeholder, "[PUBLIC_PLACEHOLDER]"); }
export function containsKnownSecret(value) {
    const candidate = markPlaceholders(value);
    return secrets.some(re => { re.lastIndex = 0; return re.test(candidate); });
}
export function redactText(value) {
    let result = markPlaceholders(value);
    for (const re of secrets) {
        re.lastIndex = 0;
        result = result.replace(re, "[REDACTED]");
    }
    return result;
}
/** Converts JSON-compatible input to scrubbed JSON, rejecting oversized or cyclic data. */
export function redactValue(value, maxBytes = 24_000) {
    const seen = new WeakSet();
    function walk(item, depth) {
        if (depth > 12)
            throw new Error("Input is too deeply nested");
        if (typeof item === "string")
            return redactText(item);
        if (typeof item === "number" || typeof item === "boolean" || item === null) {
            if (typeof item === "number" && !Number.isFinite(item))
                throw new Error("Non-finite input");
            return item;
        }
        if (Array.isArray(item)) {
            if (seen.has(item))
                throw new Error("Cyclic input");
            seen.add(item);
            try {
                return item.map(value => walk(value, depth + 1));
            }
            finally {
                seen.delete(item);
            }
        }
        if (item && typeof item === "object") {
            if (seen.has(item))
                throw new Error("Cyclic input");
            seen.add(item);
            try {
                const output = {};
                for (const [key, value] of Object.entries(item)) {
                    if (["__proto__", "constructor", "prototype"].includes(key))
                        throw new Error("Unsafe input key");
                    if (value !== undefined)
                        output[key] = walk(value, depth + 1);
                }
                return output;
            }
            finally {
                seen.delete(item);
            }
        }
        throw new Error("Unsupported input type");
    }
    const scrubbed = walk(value, 0);
    if (Buffer.byteLength(JSON.stringify(scrubbed)) > maxBytes)
        throw new Error(`Input exceeds ${maxBytes} bytes`);
    return scrubbed;
}
/** No remote call may include content from these paths. Not a complete sandbox. */
export function isPrivatePath(path) {
    const normalized = normalize(path).replaceAll("\\", "/");
    const file = basename(normalized).toLowerCase();
    return file === ".env" || (/^\.env\./.test(file) && !/^\.env\.(?:example|sample|template)$/.test(file)) || file.endsWith(".pem") || file.endsWith(".key") ||
        /(?:^|\/)(?:\.git|\.ssh|\.aws|node_modules|vendor-private|secrets)(?:\/|$)/i.test(normalized) ||
        /(?:^|\/)\.harness\/(?:runtime|audit)(?:\/|$)/i.test(normalized);
}
