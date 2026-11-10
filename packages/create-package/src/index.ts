/**
 * Entry point file for the `create-package` CLI.
 */

import cli from './cli.ts';
import { commands } from './commands.ts';

cli(process.argv, commands).catch((error) => {
  // TODO(#562): Use logger instead.
  // oxlint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
