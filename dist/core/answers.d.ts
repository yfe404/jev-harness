import type { QuestionMap, ValidatedAnswers } from "./contracts.js";
/** Validate an entire System One response before any gate evaluates it. */
export declare function validateAnswers(questions: QuestionMap, payload: unknown): ValidatedAnswers;
