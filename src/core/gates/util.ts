import type { ValidatedAnswers } from "../contracts.js";

export function choice(answers: ValidatedAnswers, name: string) {
  const value = answers[name];
  if (value?.type !== "choice") throw new Error(`Missing validated choice: ${name}`);
  return value;
}
export function noul(answers: ValidatedAnswers, name: string): number {
  const value = answers[name];
  if (value?.type !== "noul") throw new Error(`Missing validated noul: ${name}`);
  return value.probabilityTrue;
}
export function score(answers: ValidatedAnswers, name: string) {
  const value = answers[name];
  if (value?.type !== "score") throw new Error(`Missing validated score: ${name}`);
  return value;
}
