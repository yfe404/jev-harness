import type { GateDefinition, ToolPreflightEvent } from "../contracts.js";
import { choice, noul } from "./util.js";

const thresholds = { block: 0.7, confirm: 0.65, human: 0.55 } as const;
export const g1Bash: GateDefinition<ToolPreflightEvent> = {
  id: "g1-bash",
  thresholds,
  prepare(event, state) {
    if (event.intent !== "shell") return null;
    return {
      state: { command: event.input.command, goal: state.goal, constraints: state.constraints.map(c => ({ id: c.id, text: c.text })) },
      questions: {
        effect: {
          type: "choice", instructions: "What does executing this entire command do to files, processes, or remote systems?",
          criteria: {
            read_only: "Reads information or runs checks with no durable external effects.",
            reversible: "Makes a project-local change that can be undone.",
            irreversible: "Deletes valuable state, publishes irreversible changes, or terminates a shared service.",
            long_lived: "Starts a long-lived process or network connection outside a local test.",
            other: "The effect is uncertain or none of these fits.",
          },
        },
        violates_constraint: {
          type: "noul", instructions: "Does this command advance an action the owner's standing constraints prohibit?",
          criteria: { true: "It advances an explicitly prohibited action.", false: "No standing constraint forbids it." },
        },
      },
    };
  },
  evaluate(_event, answers) {
    const effect = choice(answers, "effect");
    const violates = noul(answers, "violates_constraint");
    if (effect.confidence < thresholds.human || Math.max(violates, 1 - violates) < thresholds.human)
      return { action: "escalate", reason: "Command effect or constraint relation is uncertain" };
    if (violates >= thresholds.block) return { action: "block", reason: "Command conflicts with a standing constraint" };
    if (effect.label === "irreversible" && effect.probabilities.irreversible! >= thresholds.block)
      return { action: "block", reason: "Command has an irreversible effect" };
    if (effect.label === "long_lived" && effect.probabilities.long_lived! >= thresholds.confirm)
      return { action: "confirm", reason: "Command starts a long-lived external action" };
    if (effect.label === "other") return { action: "escalate", reason: "Command effect was not classified" };
    return { action: "allow", reason: "No gated effect identified" };
  },
};
