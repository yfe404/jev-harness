import { redactText } from "./redact.js";
export function finalBlock(action, alternative) {
    return `Blocked: ${redactText(action)}. Allowed alternative: ${redactText(alternative)}. This block is final; do not work around it.`;
}
export function needsOwner(reason) {
    return `Pause and ask the project owner: ${redactText(reason)}. Do not retry this action through another tool.`;
}
