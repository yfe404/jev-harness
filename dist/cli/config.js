import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
export const CONFIG_FILE = "config.json";
const MODES = ["shadow", "enforce"];
export function parseMode(value, label = "mode") {
    const mode = value?.trim().toLowerCase();
    if (mode === "shadow" || mode === "enforce")
        return mode;
    throw new Error(`${label} must be one of: ${MODES.join(", ")}`);
}
/** Walk up from `start` to the nearest directory holding a real `.harness/` directory. */
export async function findProjectRoot(start) {
    let cursor = await realpath(start);
    for (;;) {
        try {
            const info = await lstat(join(cursor, ".harness"));
            if (info.isDirectory() && !info.isSymbolicLink())
                return cursor;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const parent = dirname(cursor);
        if (parent === cursor)
            return null;
        cursor = parent;
    }
}
export async function isInitialized(root) {
    try {
        const info = await lstat(join(root, ".harness"));
        return info.isDirectory() && !info.isSymbolicLink();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
/** `JH_MODE` overrides `.harness/config.json`; otherwise projects stay in shadow mode. Invalid config throws. */
export async function readConfig(root, env = process.env) {
    if (env.JH_MODE?.trim())
        return { mode: parseMode(env.JH_MODE, "JH_MODE"), source: "env" };
    const path = join(root, ".harness", CONFIG_FILE);
    let raw;
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096)
            throw new Error(".harness/config.json must be a small regular file");
        raw = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { mode: "shadow", source: "default" };
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(".harness/config.json is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(".harness/config.json must be a JSON object");
    const unknown = Object.keys(parsed).filter(key => key !== "mode");
    if (unknown.length)
        throw new Error(`.harness/config.json has unknown keys: ${unknown.join(", ")}`);
    const mode = parsed.mode;
    if (mode === undefined)
        return { mode: "shadow", source: "default" };
    if (typeof mode !== "string")
        throw new Error(".harness/config.json mode must be a string");
    return { mode: parseMode(mode, ".harness/config.json mode"), source: "file" };
}
export async function writeConfig(root, config) {
    const dir = join(root, ".harness");
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Project is not initialized; run `jh init` first");
    const path = join(dir, CONFIG_FILE);
    await writeAtomic(path, JSON.stringify({ mode: parseMode(config.mode) }, null, 2) + "\n");
    return path;
}
/** Temporary file in the same directory, fsync, rename. Never follows a symlink at the destination. */
export async function writeAtomic(path, content, mode = 0o644) {
    try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile())
            throw new Error(`Refusing to replace non-regular file: ${path}`);
        mode = info.mode & 0o777;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = await open(temp, "wx", mode);
    try {
        await fd.writeFile(content);
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    try {
        await rename(temp, path);
    }
    catch (error) {
        await unlink(temp).catch(() => { });
        throw error;
    }
}
