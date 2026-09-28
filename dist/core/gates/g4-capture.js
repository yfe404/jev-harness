import { choice } from "./util.js";
const thresholds = { capture: 0.7, human: 0.55 };
export const g4Capture = {
    id: "g4-capture",
    thresholds,
    prepare(event) {
        if (event.source !== "user")
            return null;
        return {
            state: { userMessage: event.text },
            questions: {
                kind: {
                    type: "choice", instructions: "Classify the user's message. Is it an enduring requirement or restriction for later work on this project?",
                    criteria: {
                        standing_constraint: "A project rule the user intends the agent to follow in future work.",
                        one_off: "An instruction only for this immediate action.",
                        feedback: "Feedback about work done, without a durable rule.",
                        question: "Requests information, without adding a durable rule.",
                        other: "None fits or intent is unclear.",
                    },
                },
            },
        };
    },
    evaluate(_event, answers) {
        const kind = choice(answers, "kind");
        if (kind.confidence < thresholds.human)
            return { action: "escalate", reason: "Standing-instruction intent is uncertain" };
        return kind.label === "standing_constraint" && kind.probabilities.standing_constraint >= thresholds.capture
            ? { action: "capture", reason: "User stated a lasting project constraint" }
            : { action: "allow", reason: "No lasting project constraint identified" };
    },
};
