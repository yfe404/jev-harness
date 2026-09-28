/** Maps Pi tool names onto the harness tool intents; everything else escalates. */
export function intentForTool(toolName) {
    switch (toolName) {
        case "bash":
        case "powershell":
            return "shell";
        case "read":
        case "grep":
        case "find":
        case "ls":
            return "read";
        case "write":
            return "write";
        case "edit":
            return "edit";
        default:
            return "other";
    }
}
/** Concatenates the text parts of a Pi tool result into one screening string. */
export function contentText(content) {
    if (!Array.isArray(content))
        return "";
    return content.map(part => (part && part.type === "text" && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}
const REASON_LIMIT = 1800;
export const oneLine = (text) => {
    const flat = text.replace(/\s*\n\s*/g, " ⏎ ");
    return flat.length <= REASON_LIMIT ? flat : `${flat.slice(0, REASON_LIMIT - 1)}…`;
};
