import type { Harness, HarnessOptions, HarnessServices } from "./contracts.js";
/**
 * Bootstrap dispatcher. Phase 2 replaces unavailable outcomes with evaluated gate verdicts.
 * Fail-safe: this scaffold never pretends to have evaluated an action.
 */
export declare function createHarness(services: HarnessServices, options?: HarnessOptions): Harness;
