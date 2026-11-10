import { describe, expect, it, beforeEach, vi } from 'vitest';

import cli from './cli.ts';
import { commands, commandMap } from './commands.ts';
import * as utils from './utils.ts';

vi.mock('./utils.ts');

/**
 * Returns a mock `process.argv` array with the provided arguments. Includes
 * default values for `process.argv[0]` and `process.argv[1]`.
 *
 * @param args - The arguments to include in the mock argv array.
 * @returns The mock argv array.
 */
function getMockArgv(...args: string[]): string[] {
  return ['/mock/path', '/mock/entry/path', ...args];
}

/**
 * Returns the parsed `yargs.Arguments` object for a given package name and
 * description.
 *
 * @param name - The package name.
 * @param description - The package description.
 * @returns The parsed argv object.
 */
function getParsedArgv(
  name: string,
  description: string,
): Record<string, string | string[]> {
  return {
    _: [],
    $0: 'create-package',
    name: `@ocap/${name}`,
    description,
  };
}

// Re: process.exit() mocking
// yargs calls process.exit() with 1 on failure
// With Jest, we can mock process.exit() to throw an error, but Vitest always
// overwrites process.exit with its own implementation. Hence, the weird error
// messages on failed commands.

describe('create-package/cli', () => {
  beforeEach(() => {
    // We actually check these.
    vi.spyOn(console, 'error');
    vi.spyOn(console, 'log');
  });

  it('should error if a string option contains only whitespace', async () => {
    const defaultCommand = commandMap.$0;
    vi.spyOn(defaultCommand, 'handler').mockImplementation(vi.fn());

    await expect(cli(getMockArgv('--name', '  '), commands)).rejects.toThrow(
      /process.exit unexpectedly called with "1"/u,
    );

    expect(console.error).toHaveBeenCalledWith(
      'The argument "name" was processed to an empty string. Please provide a value with non-whitespace characters.',
    );
  });

  describe('command: $0', () => {
    it('should call the command handler with the correct arguments', async () => {
      const defaultCommand = commandMap.$0;
      vi.spyOn(defaultCommand, 'handler');

      vi.spyOn(utils, 'readMonorepoFiles').mockResolvedValue({
        tsConfigBuild: {},
      } as utils.MonorepoFileData);
      vi.spyOn(utils, 'finalizeAndWriteData').mockResolvedValue();

      expect(
        await cli(
          getMockArgv('--name', 'foo', '--description', 'bar'),
          commands,
        ),
      ).toBeUndefined();

      expect(defaultCommand.handler).toHaveBeenCalledTimes(1);
      expect(defaultCommand.handler).toHaveBeenCalledWith(
        expect.objectContaining(getParsedArgv('foo', 'bar')),
      );
    });

    it('should handle names already prefixed with "@ocap/"', async () => {
      const defaultCommand = commandMap.$0;
      vi.spyOn(defaultCommand, 'handler');

      vi.spyOn(utils, 'readMonorepoFiles').mockResolvedValue({
        tsConfigBuild: {},
      } as utils.MonorepoFileData);
      vi.spyOn(utils, 'finalizeAndWriteData').mockResolvedValue();

      expect(
        await cli(
          getMockArgv('--name', '@ocap/foo', '--description', 'bar'),
          commands,
        ),
      ).toBeUndefined();

      expect(defaultCommand.handler).toHaveBeenCalledTimes(1);
      expect(defaultCommand.handler).toHaveBeenCalledWith(
        expect.objectContaining(getParsedArgv('foo', 'bar')),
      );
    });

    it('should create a new package', async () => {
      const defaultCommand = commandMap.$0;
      vi.spyOn(defaultCommand, 'handler').mockImplementation(vi.fn());

      expect(
        await cli(
          getMockArgv('--name', 'foo', '--description', 'bar'),
          commands,
        ),
      ).toBeUndefined();

      expect(defaultCommand.handler).toHaveBeenCalledTimes(1);
      expect(defaultCommand.handler).toHaveBeenCalledWith(
        expect.objectContaining(getParsedArgv('foo', 'bar')),
      );
    });

    it('should error if the package name is missing', async () => {
      const defaultCommand = commandMap.$0;
      vi.spyOn(defaultCommand, 'handler').mockImplementation(vi.fn());

      await expect(
        cli(getMockArgv('--description', 'bar'), commands),
      ).rejects.toThrow(/process.exit unexpectedly called with "1"/u);

      expect(console.error).toHaveBeenCalledWith(
        'Missing required argument: "name"',
      );
    });

    it('should error if the package description is missing', async () => {
      const defaultCommand = commandMap.$0;
      vi.spyOn(defaultCommand, 'handler').mockImplementation(vi.fn());

      await expect(cli(getMockArgv('--name', 'foo'), commands)).rejects.toThrow(
        /process.exit unexpectedly called with "1"/u,
      );

      expect(console.error).toHaveBeenCalledWith(
        'Missing required argument: "description"',
      );
    });
  });
});
