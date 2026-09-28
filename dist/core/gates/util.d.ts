import type { ValidatedAnswers } from "../contracts.js";
export declare function choice(answers: ValidatedAnswers, name: string): Readonly<{
    type: "choice";
    label: string;
    confidence: number;
    probabilities: Readonly<Record<string, number>>;
}>;
export declare function noul(answers: ValidatedAnswers, name: string): number;
export declare function score(answers: ValidatedAnswers, name: string): Readonly<{
    type: "score";
    value: number;
    confidence: number;
    probabilities: Readonly<Record<string, number>>;
}>;
