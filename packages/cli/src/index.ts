import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { registerCheckCommand } from "./commands/check.js";
import { registerRoutesCommand } from "./commands/routes.js";
import { registerTypegenCommand } from "./commands/typegen.js";
import { CliError, createNodeIo, type CommandIo, writeLine } from "./lib/output.js";

export function createProgram(io: CommandIo): Command {
  const program = new Command();

  program
    .name("dawn")
    .description("Dawn CLI")
    .exitOverride()
    .configureOutput({
      writeErr: (message) => {
        io.stderr(message);
      },
      writeOut: (message) => {
        io.stdout(message);
      },
    });

  registerCheckCommand(program, io);
  registerRoutesCommand(program, io);
  registerTypegenCommand(program, io);

  return program;
}

export async function run(argv: readonly string[], io: CommandIo = createNodeIo()): Promise<number> {
  const program = createProgram(io);

  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      writeLine(io.stderr, error.message);
      return error.exitCode;
    }

    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    writeLine(io.stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await run(process.argv.slice(2));
  process.exit(exitCode);
}
