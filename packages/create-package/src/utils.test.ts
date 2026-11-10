import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { format as oxfmtFormat } from 'oxfmt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';

import { MonorepoFile } from './constants.ts';
import * as fsUtils from './fs-utils.ts';
import type { FileMap } from './fs-utils.ts';
import type { MonorepoFileData, PackageData } from './utils.ts';
import { finalizeAndWriteData, readMonorepoFiles } from './utils.ts';

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('oxfmt', () => ({
  format: vi.fn(),
}));

vi.mock('./fs-utils.ts', () => ({
  readAllFiles: vi.fn(),
  writeFiles: vi.fn(),
}));

const readFormatConfig = async (): Promise<Record<string, unknown>> => {
  const {
    $schema: _schema,
    ignorePatterns: _ignorePatterns,
    overrides: _overrides,
    associations: _associations,
    ...config
  } = JSON.parse(
    await readFile(
      path.resolve(import.meta.dirname, '../../../.oxfmtrc.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  return config;
};

describe('create-package/utils', () => {
  describe('readMonorepoFiles', () => {
    const tsConfigBuild = JSON.stringify({
      references: [{ path: '../packages/foo' }],
    });

    it('should read the expected monorepo files', async () => {
      (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
        switch (path.basename(filePath) as MonorepoFile) {
          case MonorepoFile.TsConfigBuild:
            return tsConfigBuild;
          default:
            throw new Error(`Unexpected file: ${path.basename(filePath)}`);
        }
      });

      const monorepoFileData = await readMonorepoFiles();

      expect(monorepoFileData).toStrictEqual({
        tsConfigBuild: JSON.parse(tsConfigBuild),
      });
    });
  });

  describe('finalizeAndWriteData', () => {
    const getPackageData = (): PackageData => ({
      name: '@ocap/foo',
      description: 'A foo package.',
      directoryName: 'foo',
      currentYear: '2023',
    });

    const getMonorepoFileData = (): MonorepoFileData => ({
      tsConfigBuild: {
        references: [{ path: './packages/bar' }],
      },
    });

    const getReadFilesResult = (): FileMap => ({
      'src/index.ts': 'export default 42;',
      'src/index.test.ts': 'export default 42;',
      'mock1.file':
        'CURRENT_YEAR @ocap/template-package PACKAGE_DESCRIPTION template-package',
      'mock2.file': 'CURRENT_YEAR @ocap/template-package',
      'mock3.file': 'PACKAGE_DESCRIPTION template-package',
    });

    let consoleErrorSpy: MockInstance;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error');
    });

    it('should write the expected files', async () => {
      const packageData = getPackageData();

      const monorepoFileData = getMonorepoFileData();

      (fs.access as Mock).mockRejectedValueOnce(
        Object.assign(new Error(), {
          code: 'ENOENT',
        }),
      );

      (fsUtils.readAllFiles as Mock).mockResolvedValueOnce(
        getReadFilesResult(),
      );

      (oxfmtFormat as Mock).mockImplementation(
        async (_filePath: string, input: string) => ({
          code: input,
          errors: [],
        }),
      );

      await finalizeAndWriteData(packageData, monorepoFileData);

      // processTemplateFiles and writeFiles
      expect(fsUtils.readAllFiles).toHaveBeenCalledTimes(1);
      expect(fsUtils.readAllFiles).toHaveBeenCalledWith(
        expect.stringMatching(/packages\/template-package$/u),
      );

      expect(fsUtils.writeFiles).toHaveBeenCalledTimes(1);
      expect(fsUtils.writeFiles).toHaveBeenCalledWith(
        expect.stringMatching(/packages\/foo$/u),
        {
          'src/index.ts': 'export default 42;',
          'src/index.test.ts': 'export default 42;',
          'mock1.file': '2023 @ocap/foo A foo package. foo',
          'mock2.file': '2023 @ocap/foo',
          'mock3.file': 'A foo package. foo',
        },
      );

      // Writing monorepo files
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      expect(oxfmtFormat).toHaveBeenCalledTimes(1);
      const formatConfig = await readFormatConfig();
      expect(formatConfig).toHaveProperty('singleQuote');
      expect(oxfmtFormat).toHaveBeenCalledWith(
        expect.stringMatching(/[/\\]tsconfig\.build\.json$/u),
        expect.any(String),
        formatConfig,
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/tsconfig\.build\.json$/u),
        JSON.stringify({
          references: [
            { path: './packages/bar' },
            { path: './packages/foo/tsconfig.build.json' },
          ],
        }),
      );

      // Postprocessing
      expect(execa).toHaveBeenCalledTimes(2);
      expect(execa).toHaveBeenCalledWith('yarn', ['install'], {
        cwd: expect.any(String),
      });
      expect(execa).toHaveBeenCalledWith('yarn', ['constraints', '--fix'], {
        cwd: expect.any(String),
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should warn if constraints fail', async () => {
      const packageData = getPackageData();

      const monorepoFileData = getMonorepoFileData();

      (fs.access as Mock).mockRejectedValueOnce(
        Object.assign(new Error(), {
          code: 'ENOENT',
        }),
      );

      (fsUtils.readAllFiles as Mock).mockResolvedValueOnce(
        getReadFilesResult(),
      );

      (oxfmtFormat as Mock).mockImplementation(
        async (_filePath: string, input: string) => ({
          code: input,
          errors: [],
        }),
      );

      (execa as Mock)
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => {
          throw new Error('foo');
        });

      await finalizeAndWriteData(packageData, monorepoFileData);

      // Postprocessing
      expect(execa).toHaveBeenCalledTimes(2);
      expect(execa).toHaveBeenCalledWith('yarn', ['install'], {
        cwd: expect.any(String),
      });
      expect(execa).toHaveBeenCalledWith('yarn', ['constraints', '--fix'], {
        cwd: expect.any(String),
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Warning: Failed to run "yarn constraints --fix". You will need to re-run it manually.',
      );
    });

    it('throws if the package directory already exists', async () => {
      const packageData: PackageData = {
        name: '@ocap/foo',
        description: 'A foo package.',
        directoryName: 'foo',
        currentYear: '2023',
      };

      const monorepoFileData = {
        tsConfigBuild: {
          references: [{ path: './packages/bar' }],
        },
      };

      (fs.access as Mock).mockResolvedValueOnce(undefined);

      await expect(
        finalizeAndWriteData(packageData, monorepoFileData),
      ).rejects.toThrow(/^The package directory already exists:/u);

      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('throws if formatting a monorepo file fails', async () => {
      (fs.access as Mock).mockRejectedValueOnce(
        Object.assign(new Error(), {
          code: 'ENOENT',
        }),
      );
      (fsUtils.readAllFiles as Mock).mockResolvedValueOnce(
        getReadFilesResult(),
      );
      (oxfmtFormat as Mock).mockResolvedValueOnce({
        code: '',
        errors: [
          {
            message: 'bad json',
            codeframe: '  x bad json\n   ,-[tsconfig.build.json:1:2]',
          },
          { message: 'worse json', codeframe: null },
        ],
      });

      await expect(
        finalizeAndWriteData(getPackageData(), getMonorepoFileData()),
      ).rejects.toThrow(
        /^Failed to format .+tsconfig\.build\.json:\n {2}x bad json\n {3},-\[tsconfig\.build\.json:1:2\]\nworse json$/u,
      );

      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(execa).not.toHaveBeenCalled();
    });

    it('handles errors from fs.exists', async () => {
      const packageData = getPackageData();
      const monorepoFileData = getMonorepoFileData();

      (fs.access as Mock).mockRejectedValueOnce(new Error('foo'));

      await expect(
        finalizeAndWriteData(packageData, monorepoFileData),
      ).rejects.toThrow(/^foo$/u);
    });
  });
});
