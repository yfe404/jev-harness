import { choice, noul } from "./util.js";
const thresholds = { repeat: 0.8, matters: 0.4, human: 0.55 };
export const g7Dedup = {
    id: "g7-dedup",
    thresholds,
    prepare(input) {
        if (!input.prior.countsAsTrial || input.prior.result === "setup_failure")
            return null;
        return {
            state: { proposed: { hypothesis: input.proposed.hypothesis, method: input.proposed.method, changedVariable: input.proposed.changedVariable },
                prior: { id: input.prior.id, hypothesis: input.prior.hypothesis, method: input.prior.method, result: input.prior.result } },
            questions: {
                relation: {
                    type: "choice", instructions: "How does this proposed test relate to this one previous test?",
                    criteria: {
                        repeat: "Same hypothesis and method; differences are cosmetic.",
                        variant: "Same hypothesis, but a previously untested variable changes.",
                        unrelated: "Different hypothesis or target.",
                        other: "Insufficient information to compare them.",
                    },
                },
                difference_matters: {
                    type: "noul", instructions: "Would the changed variable alter what this test teaches us?",
                    criteria: { true: "New variable changes the interpretation.", false: "Difference has no bearing on the hypothesis." },
                },
            },
        };
    },
    evaluate(input, answers) {
        const relation = choice(answers, "relation");
        const matters = noul(answers, "difference_matters");
        if (relation.confidence < thresholds.human)
            return { action: "escalate", reason: "Experiment comparison is uncertain" };
        if (relation.label === "repeat" && relation.probabilities.repeat >= thresholds.repeat && matters < thresholds.matters)
            return { action: "block", reason: `Attempt repeats ${input.prior.id} (${input.prior.result})`, alternative: "Change a relevant variable or explain what new evidence this test can produce." };
        if (relation.label === "other")
            return { action: "escalate", reason: "Experiment comparison lacks information" };
        return { action: "allow", reason: "No cosmetic repeat identified" };
    },
};
