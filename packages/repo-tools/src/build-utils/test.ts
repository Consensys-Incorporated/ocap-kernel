/* oxlint-disable no-console */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PreludeRecord } from '../vite-plugins';

export type UntransformedFiles = { sourcePath: string; buildPath: string }[];

type TestParams = {
  outDir: string;
  untransformedFiles: UntransformedFiles;
  trustedPreludes: PreludeRecord;
};

/**
 * Runs all build tests.
 *
 * @param params - The parameters for the build tests.
 * @param params.outDir - The output directory.
 * @param params.untransformedFiles - The untransformed files to check.
 * @param params.trustedPreludes - The trusted preludes to check.
 */
export async function runTests({
  outDir,
  untransformedFiles,
  trustedPreludes,
}: TestParams): Promise<void> {
  try {
    await checkUntransformed(untransformedFiles);
    await checkTrustedPreludes(outDir, trustedPreludes);
    console.log('✅ Build tests passed successfully!');
    // oxlint-disable-next-line typescript/no-explicit-any
  } catch (error: any) {
    console.error(`❌ ${error.message}`);
    throw error;
  }
}

/**
 * Test that shims and preludes are packaged untransformed.
 *
 * @param untransformedFiles - The untransformed files to check.
 */
async function checkUntransformed(
  untransformedFiles: UntransformedFiles,
): Promise<void> {
  for (const { sourcePath, buildPath } of untransformedFiles) {
    const [originalContent, builtContent] = await Promise.all([
      fs.readFile(sourcePath, 'utf8'),
      fs.readFile(buildPath, 'utf8'),
    ]);
    if (originalContent.trim() !== builtContent.trim()) {
      throw new Error(
        `"${buildPath}" is transformed or differs from the original source.`,
      );
    }
  }
}

/**
 * Test that trusted preludes are loaded at the top of the file.
 *
 * @param outDir - The output directory.
 * @param trustedPreludes - The trusted preludes to check.
 */
async function checkTrustedPreludes(
  outDir: string,
  trustedPreludes: PreludeRecord,
): Promise<void> {
  for (const [outputFileName, prelude] of Object.entries(trustedPreludes)) {
    const outputFilePath = path.join(outDir, `${outputFileName}.js`);
    const outputFileContent = await fs.readFile(outputFilePath, 'utf8');
    const expectedImportStatement =
      'path' in prelude
        ? `import "./${path.basename(prelude.path)}";`
        : prelude.content;

    if (!outputFileContent.startsWith(expectedImportStatement)) {
      throw new Error(
        `The trusted prelude \`${expectedImportStatement}\` is not imported in the first position in "${outputFileName}.js"`,
      );
    }
  }
}
