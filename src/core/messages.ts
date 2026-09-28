import { redactText } from "./redact.js";

export function finalBlock(action: string, alternative: string): string {
  return `Blocked: ${redactText(action)}. Allowed alternative: ${redactText(alternative)}. This block is final; do not work around it.`;
}
export function needsOwner(reason: string): string {
  return `Pause and ask the project owner: ${redactText(reason)}. Do not retry this action through another tool.`;
}
