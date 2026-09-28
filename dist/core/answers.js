/** Validate an entire System One response before any gate evaluates it. */
export function validateAnswers(questions, payload) {
    if (!record(payload) || !record(payload.answers))
        throw new Error("Jev response has no answers object");
    const result = {};
    for (const [name, question] of Object.entries(questions)) {
        const answer = payload.answers[name];
        if (!record(answer))
            throw new Error(`Missing answer: ${name}`);
        if (answer.type !== undefined && answer.type !== question.type)
            throw new Error(`Wrong answer type: ${name}`);
        switch (question.type) {
            case "noul": {
                const p = probability(answer.noul, name);
                result[name] = { type: "noul", probabilityTrue: p, confidence: Math.max(p, 1 - p) };
                break;
            }
            case "choice": {
                const labels = Object.keys(question.criteria);
                if (!labels.includes("other") && !labels.includes("none"))
                    throw new Error(`Choice needs an exit option: ${name}`);
                if (typeof answer.choice !== "string" || !labels.includes(answer.choice))
                    throw new Error(`Unknown choice: ${name}`);
                const probabilities = validateProbabilities(answer.probabilities, labels, name);
                result[name] = {
                    type: "choice", label: answer.choice, confidence: probability(answer.confidence, name), probabilities,
                };
                break;
            }
            case "score": {
                const max = question.criteria.length - 1;
                if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > max) {
                    throw new Error(`Invalid score: ${name}`);
                }
                const labels = question.criteria.map((_, index) => String(index));
                result[name] = {
                    type: "score", value: answer.score, confidence: probability(answer.confidence, name),
                    probabilities: validateProbabilities(answer.probabilities, labels, name),
                };
                break;
            }
        }
    }
    return result;
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function probability(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        throw new Error(`Invalid probability: ${name}`);
    return value;
}
function validateProbabilities(raw, labels, name) {
    if (!record(raw) || Object.keys(raw).length !== labels.length)
        throw new Error(`Incomplete probabilities: ${name}`);
    const values = {};
    for (const label of labels)
        values[label] = probability(raw[label], `${name}.${label}`);
    return values;
}
