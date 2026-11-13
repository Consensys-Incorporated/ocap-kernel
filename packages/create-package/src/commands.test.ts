import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Arguments } from 'yargs';

import type { CreatePackageOptions } from './commands.ts';
import { createPackageHandler } from './commands.ts';
import * as utils from './utils.ts';

vi.mock('./utils.ts', () => ({
  finalizeAndWriteData: vi.fn(),
  readMonorepoFiles: vi.fn(),
}));

// January 2 to avoid time zone issues.
vi.useFakeTimers({
  now: new Date('2023-01-02'),
  toFake: ['Date'],
});

describe('create-package/commands', () => {
  describe('createPackageHandler', () => {
    it('should create the expected package', async () => {
      (utils.readMonorepoFiles as Mock).mockResolvedValue({
        tsConfigBuild: {
          references: [{ path: '../packages/foo' }],
        },
      });

      const args: Arguments<CreatePackageOptions> = {
        _: [],
        $0: 'create-package',
        name: '@ocap/new-package',
        description: 'A new MetaMask package.',
      };

      await createPackageHandler(args);

      expect(utils.finalizeAndWriteData).toHaveBeenCalledTimes(1);
      expect(utils.finalizeAndWriteData).toHaveBeenCalledWith(
        {
          name: '@ocap/new-package',
          description: 'A new MetaMask package.',
          directoryName: 'new-package',
          currentYear: '2023',
        },
        {
          tsConfigBuild: {
            references: [{ path: '../packages/foo' }],
          },
        },
      );
    });
  });
});
