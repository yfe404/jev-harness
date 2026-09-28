// Claude Code settings installer: builds the hook fragment and merges it into a
// settings file idempotently, preserving unrelated hooks, keys, and formatting
// decisions it did not make. Refuses malformed files rather than overwriting them.
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export const HOOK_TIMEOUT_SECONDS = 15;
/** One dispatcher command per event; identical commands are deduplicated by the host. */
export const CLAUDE_HOOK_EVENTS = [
    { event: "UserPromptSubmit" },
    { event: "PreToolUse", matcher: "*" },
    { event: "PostToolUse", matcher: "*" },
    { event: "Stop" },
    { event: "PreCompact" },
    { event: "SessionStart", matcher: "startup|resume|clear|compact" },
];
/** POSIX single-quote escaping for paths with spaces; rejects control characters. */
export function quotePosix(value) {
    if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
        throw new Error("Path is empty or contains a forbidden control character");
    }
    return `'${value.replaceAll("'", "'\\''")}'`;
}
/** Fixed argv; no agent-controlled content is ever spliced into this string. */
export function hookCommand(paths) {
    return `${quotePosix(paths.nodePath)} ${quotePosix(paths.cliPath)} hook claude`;
}
/** Conservative ownership: our dispatcher command, possibly installed from an older path. */
export function isJevHookEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return false;
    const candidate = entry;
    return candidate.type === "command" && typeof candidate.command === "string" &&
        candidate.command.includes("jev-harness") && candidate.command.endsWith(" hook claude");
}
function ourEntry(command) {
    return { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS };
}
/** The printable fragment: what `jh install claude --print` shows. */
export function buildSettingsFragment(paths) {
    const command = hookCommand(paths);
    const hooks = {};
    for (const spec of CLAUDE_HOOK_EVENTS) {
        hooks[spec.event] = [{ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [ourEntry(command)] }];
    }
    return { hooks };
}
function plainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
 * Pure merge of our entries into parsed settings. Throws on structures we refuse
 * to guess at. Returns changed=false when every entry is already current.
 */
export function mergeHooks(existing, command) {
    const settings = structuredClone(existing);
    if (settings.hooks !== undefined && !plainObject(settings.hooks)) {
        throw new Error("Settings `hooks` key is not an object; refusing to modify the file");
    }
    const hooks = (settings.hooks ??= {});
    let changed = false;
    for (const spec of CLAUDE_HOOK_EVENTS) {
        if (hooks[spec.event] !== undefined && !Array.isArray(hooks[spec.event])) {
            throw new Error(`Settings hooks.${spec.event} is not an array; refusing to modify the file`);
        }
        const groups = (hooks[spec.event] ??= []);
        // Find every existing entry of ours for this event; keep the first, drop duplicates.
        let placed = false;
        for (let g = groups.length - 1; g >= 0; g--) {
            const group = groups[g];
            if (!plainObject(group) || !Array.isArray(group.hooks)) {
                throw new Error(`Settings hooks.${spec.event}[${g}] is not a hook group; refusing to modify the file`);
            }
            const entries = group.hooks;
            for (let h = entries.length - 1; h >= 0; h--) {
                if (!isJevHookEntry(entries[h]))
                    continue;
                if (!placed) {
                    const next = ourEntry(command);
                    if (JSON.stringify(entries[h]) !== JSON.stringify(next)) {
                        entries[h] = next;
                        changed = true;
                    }
                    placed = true;
                }
                else {
                    entries.splice(h, 1);
                    changed = true;
                }
            }
            if (entries.length === 0 && placed) {
                // The group became empty because it only ever held our entry.
                groups.splice(g, 1);
                changed = true;
            }
        }
        if (!placed) {
            groups.push({ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [ourEntry(command)] });
            changed = true;
        }
    }
    return { settings, changed };
}
/** Pure removal of our entries; drops only groups/keys emptied by that removal. */
export function removeHooks(existing) {
    const settings = structuredClone(existing);
    if (!plainObject(settings.hooks))
        return { settings, changed: false };
    const hooks = settings.hooks;
    let changed = false;
    for (const event of Object.keys(hooks)) {
        const groups = hooks[event];
        if (!Array.isArray(groups))
            continue;
        for (let g = groups.length - 1; g >= 0; g--) {
            const group = groups[g];
            if (!plainObject(group) || !Array.isArray(group.hooks))
                continue;
            const entries = group.hooks;
            const before = entries.length;
            for (let h = entries.length - 1; h >= 0; h--) {
                if (isJevHookEntry(entries[h])) {
                    entries.splice(h, 1);
                    changed = true;
                }
            }
            if (before > 0 && entries.length === 0)
                groups.splice(g, 1);
        }
        if (groups.length === 0) {
            delete hooks[event];
            changed = true;
        }
    }
    if (Object.keys(hooks).length === 0)
        delete settings.hooks;
    return { settings, changed };
}
export function settingsPathFor(scope, options) {
    switch (scope) {
        case "user": return join(options.homeDir, ".claude", "settings.json");
        case "project": return join(options.projectRoot, ".claude", "settings.json");
        case "local": return join(options.projectRoot, ".claude", "settings.local.json");
    }
}
async function readSettings(file) {
    let raw;
    try {
        raw = await readFile(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`Refusing to modify ${file}: it is not valid JSON. Fix or remove it manually; no changes were made.`);
    }
    if (!plainObject(parsed))
        throw new Error(`Refusing to modify ${file}: the top level is not a JSON object.`);
    return { raw, parsed };
}
async function atomicWrite(file, content) {
    await mkdir(dirname(file), { recursive: true });
    let mode = 0o600;
    try {
        const info = await lstat(file);
        if (info.isSymbolicLink())
            throw new Error(`Refusing to write through symlink: ${file}`);
        mode = info.mode & 0o777;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    const fd = await open(temp, "wx", mode);
    try {
        await fd.writeFile(content);
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    try {
        await rename(temp, file);
    }
    catch (error) {
        await unlink(temp).catch(() => { });
        throw error;
    }
}
async function gitignoreAdvice(scope, projectRoot, warnings) {
    if (scope !== "local")
        return;
    const relative = ".claude/settings.local.json";
    const path = join(projectRoot, ".gitignore");
    try {
        const content = await readFile(path, "utf8");
        if (!content.split("\n").some(line => line.trim() === relative)) {
            await writeFile(path, `${content.endsWith("\n") || content.length === 0 ? content : `${content}\n`}${relative}\n`);
            warnings.push(`Added ${relative} to .gitignore`);
        }
    }
    catch (error) {
        if (error.code === "ENOENT") {
            warnings.push(`Add ${relative} to your .gitignore; local settings are machine-specific.`);
        }
        else
            throw error;
    }
}
const GENERAL_WARNINGS = [
    "Hooks run only in workspaces you trust in Claude Code, and are disabled by --bare or disableAllHooks.",
    "Hooks are advisory enforcement, not a sandbox: a crashed or timed-out hook lets the action proceed.",
];
export async function installClaudeHooks(options) {
    const file = settingsPathFor(options.scope, options);
    const command = hookCommand(options.paths);
    const existing = await readSettings(file);
    const { settings, changed } = mergeHooks(existing?.parsed ?? {}, command);
    const warnings = [...GENERAL_WARNINGS];
    if (!changed && existing) {
        const serialized = `${JSON.stringify(settings, null, 2)}\n`;
        if (serialized === existing.raw)
            return { file, action: "unchanged", warnings };
    }
    let backup;
    if (existing) {
        backup = `${file}.jev.bak`;
        await copyFile(file, backup);
    }
    await atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
    await gitignoreAdvice(options.scope, options.projectRoot, warnings);
    return { file, action: "installed", ...(backup ? { backup } : {}), warnings };
}
export async function uninstallClaudeHooks(options) {
    const file = settingsPathFor(options.scope, options);
    const existing = await readSettings(file);
    if (!existing)
        return { file, action: "absent", warnings: [] };
    const { settings, changed } = removeHooks(existing.parsed);
    if (!changed)
        return { file, action: "unchanged", warnings: [] };
    const backup = `${file}.jev.bak`;
    await copyFile(file, backup);
    await atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
    return { file, action: "uninstalled", backup, warnings: [] };
}
export async function claudeHookStatus(options) {
    const file = settingsPathFor(options.scope, options);
    const existing = await readSettings(file);
    if (!existing) {
        return { file, exists: false, events: CLAUDE_HOOK_EVENTS.map(({ event }) => ({ event, installed: false })) };
    }
    const hooks = plainObject(existing.parsed.hooks) ? existing.parsed.hooks : {};
    return {
        file, exists: true,
        events: CLAUDE_HOOK_EVENTS.map(({ event }) => {
            const groups = hooks[event];
            if (!Array.isArray(groups))
                return { event, installed: false };
            for (const group of groups) {
                if (!plainObject(group) || !Array.isArray(group.hooks))
                    continue;
                const ours = group.hooks.find(isJevHookEntry);
                if (ours)
                    return { event, installed: true, ...(typeof ours.command === "string" ? { command: ours.command } : {}) };
            }
            return { event, installed: false };
        }),
    };
}
