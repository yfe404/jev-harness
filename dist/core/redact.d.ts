export declare function containsKnownSecret(value: string): boolean;
export declare function redactText(value: string): string;
/** Converts JSON-compatible input to scrubbed JSON, rejecting oversized or cyclic data. */
export declare function redactValue(value: unknown, maxBytes?: number): unknown;
/** No remote call may include content from these paths. Not a complete sandbox. */
export declare function isPrivatePath(path: string): boolean;
