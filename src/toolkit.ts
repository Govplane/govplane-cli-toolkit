import { run as runCli, type RunOptions } from '@govplane/cli';
import { commands } from './commands/registry.js';

export type ToolkitRunOptions = Omit<RunOptions, 'extraCommands'>;

/**
 * Runs the CLI with the CLI Toolkit's commands registered.
 *
 * The toolkit does not reimplement the command line: it hands its commands to
 * the same `run()` the `govplane` executable uses, so parsing, help, output
 * formats and exit codes behave identically whichever executable was invoked.
 */
export const run = async (
  argv: string[],
  options: ToolkitRunOptions = {},
): Promise<number> => runCli(argv, { ...options, extraCommands: commands });

/** Entry point used by `bin/govplane-toolkit.js`. */
export const main = async (argv: string[]): Promise<number> => run(argv);
