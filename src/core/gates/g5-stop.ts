import type { GateDefinition, UserInputEvent } from "../contracts.js";
import { noul } from "./util.js";

const thresholds = { freeze: 0.7, human: 0.6 } as const;
export const g5Stop: GateDefinition<UserInputEvent> = {
  id: "g5-stop",
  thresholds,
  prepare(event) {
    if (event.source !== "user") return null;
    return {
      state: { userMessage: event.text },
      questions: {
        stop_or_correct: { type: "noul", instructions: "Is the user asking the agent to stop, or correcting the approach it is taking right now?",
          criteria: { true: "The user wants a pause and acknowledgment before further tool actions.", false: "Ordinary new work or a question without a correction." } },
      },
    };
  },
  evaluate(_event, answers) {
    const p = noul(answers, "stop_or_correct");
    if (p >= thresholds.freeze) return { action: "freeze", reason: "User corrected or stopped the current approach", alternative: "Reply in text to acknowledge the correction, then wait for a new user request." };
    if (Math.max(p, 1 - p) < thresholds.human) return { action: "escalate", reason: "Uncertain whether user requested a stop" };
    return { action: "allow", reason: "No stop signal identified" };
  },
};
