import type { CommandDefinition } from '@govplane/cli';
import { activateCommand } from './activate.js';
import { analyzeCommand } from './analyze.js';
import { buildCommand } from './build.js';
import { licenseCommand } from './license.js';
import { policiesCommand } from './policies.js';
import { signCommand } from './sign.js';
import { simulateCommand } from './simulate.js';

/**
 * Commands the CLI Toolkit contributes to the `govplane` CLI.
 *
 * The CLI discovers this list at runtime (see `loadToolkitCommands` in
 * `@govplane/cli`), so installing the toolkit is all it takes for these to
 * appear in `govplane help`.
 *
 * Every command here calls `requireActivation()` before doing any work.
 */
export const commands: CommandDefinition[] = [
  activateCommand,
  licenseCommand,
  policiesCommand,
  buildCommand,
  signCommand,
  simulateCommand,
  analyzeCommand,
];
