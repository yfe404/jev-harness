import type { Decision, EventContext, GateDefinition, Harness, HarnessOptions, HarnessServices, Mode, StateSnapshot } from "./contracts.js";
interface NamedGate<Input> {
    readonly gate: GateDefinition<Input>;
    readonly input: Input;
}
/** Batches compatible questions into provider requests and audits each gate before
 * applying actions. Gates are packed deterministically (in gate order) into as few
 * requests as fit the redaction budget; a gate whose redacted state alone exceeds
 * the budget fails unavailable rather than being judged on truncated data. */
export declare function runBatchedGates<Input>(gates: readonly NamedGate<Input>[], ctx: EventContext, state: StateSnapshot, services: HarnessServices, mode: Mode, signal?: AbortSignal): Promise<readonly Decision[]>;
export declare function createHarness(services: HarnessServices, options?: HarnessOptions): Harness;
export {};
