import { readFileSync } from "node:fs";
import type { DecisionProvider, ProviderRequest, Question } from "../core/contracts.js";
import { ProviderUnavailableError } from "../core/client.js";

/**
 * Offline provider for examples and tests. It answers from a script of synthetic replies,
 * so it proves the wiring and thresholds, never Jev's judgment.
 *
 * {
 *   "replies": [
 *     { "gate": "g6-plan", "when": "left-pad", "answers": { "violates": { "matching": "dependencies" }, "relation_to_goal": "direct" } },
 *     { "gate": "g6-plan", "answers": { "violates": "none", "relation_to_goal": "direct" } }
 *   ]
 * }
 *
 * The first reply whose `gate` matches and whose `when` text (or every entry of a `when` array)
 * appears in that gate's request state, case-insensitively, is used. Shorthand answers:
 * - noul: a probability, e.g. `0.9`
 * - choice: a label, `{ "matching": "text in the option description" }`, or `{ "label": "x", "p": 0.8 }`
 * - score: a level index, e.g. `2`
 * Full System One answer objects are passed through unchanged.
 */
export interface ReplayRule {
  readonly gate: string;
  readonly when?: string | readonly string[];
  readonly answers: Readonly<Record<string, unknown>>;
}

export function loadReplayRules(path: string): readonly ReplayRule[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read replay file ${path}: ${(error as Error).message}`); }
  const replies = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { replies?: unknown }).replies : parsed;
  if (!Array.isArray(replies)) throw new Error("Replay file needs a `replies` array");
  return replies.map((rule, index) => {
    if (!rule || typeof rule !== "object" || typeof (rule as ReplayRule).gate !== "string" ||
      !(rule as ReplayRule).answers || typeof (rule as ReplayRule).answers !== "object") throw new Error(`Replay reply ${index} needs gate and answers`);
    return rule as ReplayRule;
  });
}

export function createReplayProvider(rules: readonly ReplayRule[]): DecisionProvider {
  return {
    async decide(request: ProviderRequest): Promise<unknown> {
      const states = request.state && typeof request.state === "object" ? request.state as Record<string, unknown> : {};
      const answers: Record<string, unknown> = {};
      for (const gate of Object.keys(states)) {
        const haystack = JSON.stringify(states[gate] ?? "").toLowerCase();
        const rule = rules.find(r => r.gate === gate && matches(r.when, haystack));
        if (!rule) throw new ProviderUnavailableError(`No recorded reply for ${gate}`);
        for (const [key, question] of Object.entries(request.questions)) {
          if (!key.startsWith(`${gate}_`)) continue;
          const name = key.slice(gate.length + 1);
          if (!Object.hasOwn(rule.answers, name)) throw new ProviderUnavailableError(`Recorded reply for ${gate} lacks ${name}`);
          answers[key] = expand(question, rule.answers[name]);
        }
      }
      return { answers };
    },
  };
}

function matches(when: ReplayRule["when"], haystack: string): boolean {
  if (when === undefined) return true;
  const all = typeof when === "string" ? [when] : when;
  return all.every(part => haystack.includes(part.toLowerCase()));
}

function spread(labels: readonly string[], selected: string, p: number): Record<string, number> {
  // A single-label choice (e.g. g6 violates with no constraints) must still sum to one.
  if (labels.length === 1) return { [labels[0]!]: 1 };
  const rest = (1 - p) / (labels.length - 1);
  return Object.fromEntries(labels.map(label => [label, label === selected ? p : rest]));
}

function expand(question: Question, value: unknown): unknown {
  if (value && typeof value === "object" && ("noul" in value || "choice" in value || "score" in value)) return value;
  if (question.type === "noul") {
    if (typeof value !== "number") throw new ProviderUnavailableError("Replay noul answer must be a number");
    return { type: "noul", noul: value };
  }
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    let label: string | undefined;
    let p = 0.9;
    if (typeof value === "string") label = value;
    else if (value && typeof value === "object") {
      const spec = value as { label?: unknown; matching?: unknown; p?: unknown };
      if (typeof spec.p === "number") p = spec.p;
      if (typeof spec.label === "string") label = spec.label;
      else if (typeof spec.matching === "string") {
        const needle = spec.matching.toLowerCase();
        label = labels.find(l => (question.criteria[l] ?? "").toLowerCase().includes(needle));
      }
    }
    if (!label || !labels.includes(label)) throw new ProviderUnavailableError("Replay choice answer does not match an option");
    return { type: "choice", choice: label, confidence: p, probabilities: spread(labels, label, p) };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ProviderUnavailableError("Replay score answer must be a level index");
  const labels = question.criteria.map((_, index) => String(index));
  return { type: "score", score: value, confidence: 0.9, probabilities: spread(labels, String(value), 0.9) };
}
