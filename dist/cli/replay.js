import { readFileSync } from "node:fs";
import { ProviderUnavailableError } from "../core/client.js";
export function loadReplayRules(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        throw new Error(`Cannot read replay file ${path}: ${error.message}`);
    }
    const replies = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.replies : parsed;
    if (!Array.isArray(replies))
        throw new Error("Replay file needs a `replies` array");
    return replies.map((rule, index) => {
        if (!rule || typeof rule !== "object" || typeof rule.gate !== "string" ||
            !rule.answers || typeof rule.answers !== "object")
            throw new Error(`Replay reply ${index} needs gate and answers`);
        return rule;
    });
}
export function createReplayProvider(rules) {
    return {
        async decide(request) {
            const states = request.state && typeof request.state === "object" ? request.state : {};
            const answers = {};
            for (const gate of Object.keys(states)) {
                const haystack = JSON.stringify(states[gate] ?? "").toLowerCase();
                const rule = rules.find(r => r.gate === gate && matches(r.when, haystack));
                if (!rule)
                    throw new ProviderUnavailableError(`No recorded reply for ${gate}`);
                for (const [key, question] of Object.entries(request.questions)) {
                    if (!key.startsWith(`${gate}_`))
                        continue;
                    const name = key.slice(gate.length + 1);
                    if (!Object.hasOwn(rule.answers, name))
                        throw new ProviderUnavailableError(`Recorded reply for ${gate} lacks ${name}`);
                    answers[key] = expand(question, rule.answers[name]);
                }
            }
            return { answers };
        },
    };
}
function matches(when, haystack) {
    if (when === undefined)
        return true;
    const all = typeof when === "string" ? [when] : when;
    return all.every(part => haystack.includes(part.toLowerCase()));
}
function spread(labels, selected, p) {
    // A single-label choice (e.g. g6 violates with no constraints) must still sum to one.
    if (labels.length === 1)
        return { [labels[0]]: 1 };
    const rest = (1 - p) / (labels.length - 1);
    return Object.fromEntries(labels.map(label => [label, label === selected ? p : rest]));
}
function expand(question, value) {
    if (value && typeof value === "object" && ("noul" in value || "choice" in value || "score" in value))
        return value;
    if (question.type === "noul") {
        if (typeof value !== "number")
            throw new ProviderUnavailableError("Replay noul answer must be a number");
        return { type: "noul", noul: value };
    }
    if (question.type === "choice") {
        const labels = Object.keys(question.criteria);
        let label;
        let p = 0.9;
        if (typeof value === "string")
            label = value;
        else if (value && typeof value === "object") {
            const spec = value;
            if (typeof spec.p === "number")
                p = spec.p;
            if (typeof spec.label === "string")
                label = spec.label;
            else if (typeof spec.matching === "string") {
                const needle = spec.matching.toLowerCase();
                label = labels.find(l => (question.criteria[l] ?? "").toLowerCase().includes(needle));
            }
        }
        if (!label || !labels.includes(label))
            throw new ProviderUnavailableError("Replay choice answer does not match an option");
        return { type: "choice", choice: label, confidence: p, probabilities: spread(labels, label, p) };
    }
    if (typeof value !== "number" || !Number.isInteger(value))
        throw new ProviderUnavailableError("Replay score answer must be a level index");
    const labels = question.criteria.map((_, index) => String(index));
    return { type: "score", score: value, confidence: 0.9, probabilities: spread(labels, String(value), 0.9) };
}
