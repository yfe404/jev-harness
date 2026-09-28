import type { CompactionRegistry, EventContext } from "../contracts.js";
/** Durable append-only registry in the project's ignored `.harness/runtime/`.
 * Bound to the construction context's host and project; corrupt or oversized
 * files fail closed instead of being guessed around. */
export declare function createFileCompactionRegistry(context: EventContext): CompactionRegistry;
/** In-memory registry for contract tests and hosts with their own persistence. */
export declare function createMemoryCompactionRegistry(): CompactionRegistry;
