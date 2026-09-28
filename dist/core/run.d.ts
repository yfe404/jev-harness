import type { Decision, EventContext, GateDefinition, Harness, HarnessOptions, HarnessServices, Mode, StateSnapshot } from "./contracts.js";
interface NamedGate<Input> {
    readonly gate: GateDefinition<Input>;
    readonly input: Input;
}
/** Batches compatible questions into one request and audits each gate before applying actions. */
export declare function runBatchedGates<Input>(gates: readonly NamedGate<Input>[], ctx: EventContext, state: StateSnapshot, services: HarnessServices, mode: Mode, signal?: AbortSignal): Promise<readonly Decision[]>;
export declare function createHarness(services: HarnessServices, options?: HarnessOptions): Harness;
export {};
