import { noul, score } from "./util.js";
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
}
/** Code, not a model, checks paired measurements differ in exactly one named key. */
export function validPairedComparison(comparison) {
    const { control, treatment, variedKey } = comparison;
    if (!Object.hasOwn(control, variedKey) || !Object.hasOwn(treatment, variedKey))
        return false;
    const keys = Object.keys(control).sort();
    if (canonical(keys) !== canonical(Object.keys(treatment).sort()))
        return false;
    if (canonical(control[variedKey]) === canonical(treatment[variedKey]))
        return false;
    return keys.every(key => key === variedKey || canonical(control[key]) === canonical(treatment[key]));
}
const thresholds = { supported: 0.6, human: 0.55, causal: 1.5 };
export const g8Claim = {
    id: "g8-claim",
    thresholds,
    prepare(event, state) {
        const cited = state.evidence.filter(e => event.evidenceIds.includes(e.id));
        return {
            state: { claim: event.claim, purpose: event.purpose, evidence: cited, comparison: event.comparison },
            questions: {
                supported: { type: "noul", instructions: "Does the observed evidence cited here support the exact wording of the claim?",
                    criteria: { true: "Every important assertion follows from the cited observations.", false: "The claim is stronger than the observations or lacks evidence." } },
                causal_strength: { type: "score", instructions: "How strong a causal assertion does this claim make?",
                    criteria: ["Describes an observation only.", "Suggests an association.", "Asserts that one factor caused another."] },
            },
        };
    },
    evaluate(event, answers) {
        const supported = noul(answers, "supported");
        const causal = score(answers, "causal_strength");
        if (Math.max(supported, 1 - supported) < thresholds.human || causal.confidence < thresholds.human)
            return { action: "escalate", reason: "Claim support is uncertain" };
        if (supported < thresholds.supported) {
            if (event.purpose === "commit" || causal.value >= thresholds.causal)
                return { action: "block", reason: "Claim is stronger than the observed evidence", alternative: "State the result as inconclusive or cite verified evidence." };
            return { action: "remind", reason: "Phrase the conclusion as inconclusive until it has evidence" };
        }
        return { action: "allow", reason: "Claim is supported by cited observations" };
    },
};
