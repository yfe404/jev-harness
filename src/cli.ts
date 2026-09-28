#!/usr/bin/env node
// jh — project-local Jev decision gates for coding agents.
// Entry point: parses argv, prints help, dispatches to src/cli/commands.ts.
import { fileURLToPath } from "node:url";
import { EXIT, UsageError, runCommand, type CliEnv, type Parsed } from "./cli/commands.js";

const HELP = `jh — project-local Jev decision gates for coding agents

WHAT THIS IS
  jev-harness puts auditable judgment gates between a coding agent and its
  actions: standing owner rules are captured verbatim, plans and commands are
  checked against them, corrections freeze tool use until a new request, and
  claims must cite observed evidence. Projects opt in explicitly; everything
  starts in shadow mode (verdicts are audited, nothing is blocked).

OFFLINE QUICKSTART (no API key, synthetic answers)
  node --version                      # needs Node 24+
  jh example list                     # four runnable offline examples
  jh example run no-new-dependencies
  jh eval                             # validate the synthetic fixture files

COMMANDS
  init --goal "<outcome>"             create .harness/ in this project (owner opt-in)
  status                              show mode, goal, constraints, attempts, freeze state
  mode [shadow|enforce]               show or set the project mode (default: shadow)

  install claude [--scope local|project|user] [--print]
                                      install Claude Code hooks (default scope: local)
  uninstall claude [--scope ...]      remove only our hook entries
  hooks claude [--scope ...]          show which hook events are installed
  hook claude                         hook dispatcher; reads one event JSON from stdin

  check shell -- <command...>         preflight a shell command (G1+G6)
  check write --path <p> [--content-file <f>]
                                      preflight a file write (G2+G6)
  check claim --claim <text> --evidence <id,...> [--purpose explicit|commit|checkpoint]
                                      verify a claim cites observed evidence (G8)

  constraints list | add "<rule>"     explicit owner management of standing rules
  attempts list | register --hypothesis <h> --method <m> [--changed-variable <v>]
  evidence observe --method <m> [--attempt <id>] [--timeout <s>] -- <command...>
                                      execute a command (sanitized env, bounded, killed
                                      with its process tree on timeout) and record what
                                      was observed: exit code and output, nothing more.
                                      The CLI cannot attach confirmed/refuted results —
                                      an exit code alone is not experiment evidence
  compact validate [--summary-file <f> | --summary <t>] [--note-file <f>]
                   [--checkpoint-file <f>] [--reason manual|threshold|overflow|external]
  compact acknowledge --compaction-id <id> --validation-id <id>
                   [--summary-file <f> | --summary <t>] [--note-file <f>]
                   [--checkpoint-file <f>]
                                      resend the exact validated candidate so the ack
                                      can be checked against the validation record

  replay <audit.jsonl>                inspect recorded verdicts and check invariants
  eval [--fixtures <dir>]             validate synthetic evaluation fixtures (offline)
  example list | run <name> [--check] run a bundled offline example

GLOBAL FLAGS
  --root <dir>      project directory (default: walk up from cwd for .harness/)
  --replay <file>   answer gates from a synthetic replay script instead of live Jev
                    (JH_REPLAY does the same; useful for tests and examples)
  --json            machine-readable output for check/verdict commands
  --help, -h        this text

ENVIRONMENT
  JH_MODE=shadow|enforce   overrides .harness/config.json
  JH_SESSION_ID / JH_REQUEST_ID   pin the CLI identity across invocations
                             (required between compact validate and acknowledge)
  TYPESAFE_API_KEY / OPENROUTER_API_KEY   live Jev transport (never stored in state)

EXIT CODES
  0  success / action allowed      2  action blocked or escalated
  1  inert, unavailable, or error  64 usage error
  Installed hooks (jh hook claude) follow the host contract: an unevaluable
  PreToolUse (malformed payload, broken config, internal error, deadline) is
  denied with exit 2; other hook failures are non-blocking (exit 1) because
  exit 2 there would erase your prompt or force more agent work.

HONEST COVERAGE
  Automatic interception exists only where host hooks are installed (Claude Code
  events today). Git commits, final answers, and arbitrary shell side effects are
  NOT automatically intercepted — use the explicit check/evidence commands above.
  Hooks are advisory enforcement, not a sandbox. No live accuracy has been measured.
`;

const BOOLEAN_FLAGS = new Set(["help", "h", "json", "print", "check"]);

export function parseArgs(argv: readonly string[]): Parsed {
  const args: string[] = [];
  const rest: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let positional = true;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (positional && token === "--") { positional = false; continue; }
    if (positional && token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq));
      if (!name) throw new UsageError("Empty flag name");
      if (eq !== -1) flags[name] = token.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        flags[name] = value;
      }
      continue;
    }
    if (positional && token === "-h") { flags.help = true; continue; }
    (positional ? args : rest).push(token);
  }
  return { args, flags, rest };
}

async function main(): Promise<number> {
  // Piping into `head` and similar must not crash the CLI with EPIPE.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") process.exit(0);
      throw error;
    });
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.help || parsed.args.length === 0) {
    process.stdout.write(HELP);
    return parsed.args.length === 0 && !parsed.flags.help ? EXIT.usage : EXIT.ok;
  }
  const io: CliEnv = {
    cwd: process.cwd(),
    env: process.env,
    execPath: process.execPath,
    cliPath: fileURLToPath(import.meta.url),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    readStdin: async () => {
      if (process.stdin.isTTY) return "";
      return new Promise((resolve, reject) => {
        // Bounded: hook payloads are small; a flooded stdin is truncated and
        // will fail JSON parsing, which the hook path fails closed on.
        const LIMIT = 4 * 1024 * 1024;
        let data = "";
        let size = 0;
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => {
          size += chunk.length;
          if (size <= LIMIT) data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
      });
    },
  };
  return await runCommand(parsed, io);
}

main().then(code => { process.exitCode = code; }, error => {
  if (error instanceof UsageError) {
    process.stderr.write(`jh: ${error.message}\nRun \`jh --help\` for usage.\n`);
    process.exitCode = EXIT.usage;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`jh: ${message}\n`);
    process.exitCode = EXIT.failure;
  }
});
