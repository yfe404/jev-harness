#!/usr/bin/env node
// Bootstrap CLI entry. The delegated CLI builder replaces this with the jh commands.
const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  process.stdout.write("jh: project-local Jev decision gates for coding agents\n\nThis repository is in bootstrap. Commands are not installed yet.\n");
} else {
  process.stderr.write(`jh: command '${args[0]}' is not available in this bootstrap build\n`);
  process.exitCode = 2;
}
