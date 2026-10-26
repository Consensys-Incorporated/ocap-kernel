import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOxfmtConfig } from '@ocap/repo-tools/build-utils/oxfmt-config';
import { format as oxfmtFormat } from 'oxfmt';

import { MonorepoFile, Placeholder } from './constants.ts';
import type { FileMap } from './fs-utils.ts';
import { readAllFiles, writeFiles } from './fs-utils.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));

const PACKAGE_TEMPLATE_DIR = path.join(currentDir, '../../template-package');
const REPO_ROOT = path.join(currentDir, '..', '..', '..');
const REPO_TS_CONFIG_BUILD = path.join(REPO_ROOT, MonorepoFile.TsConfigBuild);
const PACKAGES_PATH = path.join(REPO_ROOT, 'packages');

const allPlaceholdersRegex = new RegExp(
  Object.values(Placeholder).join('|'),
  'gu',
);

/**
 * The data necessary to create a new package.
 */
export type PackageData = Readonly<{
  name: string;
  description: string;
  directoryName: string;
  currentYear: string;
}>;

/**
 * Data parsed from relevant monorepo files.
 */
export type MonorepoFileData = {
  tsConfigBuild: Tsconfig;
};

/**
 * A parsed tsconfig file.
 */
type Tsconfig = {
  references: { path: string }[];
  [key: string]: unknown;
};

/**
 * Reads the monorepo files that need to be parsed or modified.
 *
 * @returns A map of file paths to file contents.
 */
export async function readMonorepoFiles(): Promise<MonorepoFileData> {
  const tsConfigBuild = await fs.readFile(REPO_TS_CONFIG_BUILD, 'utf-8');

  return {
    tsConfigBuild: JSON.parse(tsConfigBuild) as Tsconfig,
  };
}

/**
 * Finalizes package and repo files, writes them to disk, and performs necessary
 * postprocessing (e.g. running `yarn install`).
 *
 * @param packageData - The package data.
 * @param monorepoFileData - The monorepo file data.
 */
export async function finalizeAndWriteData(
  packageData: PackageData,
  monorepoFileData: MonorepoFileData,
): Promise<void> {
  const packagePath = path.join(PACKAGES_PATH, packageData.directoryName);
  if (await exists(packagePath)) {
    throw new Error(`The package directory already exists: ${packagePath}`);
  }

  // TODO(#562): Use logger instead or change lint rule.
  // oxlint-disable-next-line no-console
  console.log('Writing package and monorepo files...');

  // Read and write package files
  await writeFiles(packagePath, await processTemplateFiles(packageData));

  // Write monorepo files
  updateTsConfigs(packageData, monorepoFileData);
  await writeJsonFile(
    REPO_TS_CONFIG_BUILD,
    JSON.stringify(monorepoFileData.tsConfigBuild),
  );

  // Postprocess
  // Add the new package to the lockfile.
  // TODO(#562): Use logger instead or change lint rule.
  // oxlint-disable-next-line no-console
  console.log('Running "yarn install"...');
  await execa('yarn', ['install'], { cwd: REPO_ROOT });

  // Run constraints
  // TODO(#562): Use logger instead or change lint rule.
  // oxlint-disable-next-line no-console
  console.log('Running "yarn constraints --fix"...');
  try {
    await execa('yarn', ['constraints', '--fix'], { cwd: REPO_ROOT });
  } catch {
    // TODO(#562): Use logger instead or change lint rule.
    // oxlint-disable-next-line no-console
    console.error(
      'Warning: Failed to run "yarn constraints --fix". You will need to re-run it manually.',
    );
  }
}

/**
 * Checks if a file exists.
 *
 * @param filePath - The absolute path of the file to check.
 * @returns Whether the file exists.
 */
async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error) {
      return error.code !== 'ENOENT';
    }
    // Unexpected error
    throw error;
  }
}

/**
 * Formats a JSON file with `oxfmt` and writes it to disk.
 *
 * @param filePath - The absolute path of the file to write.
 * @param fileContent - The file content to write.
 */
async function writeJsonFile(
  filePath: string,
  fileContent: string,
): Promise<void> {
  const { code, errors } = await oxfmtFormat(
    filePath,
    fileContent,
    await loadOxfmtConfig(),
  );
  if (errors.length > 0) {
    throw new Error(
      `Failed to format ${filePath}:\n${errors.map((error) => error.codeframe ?? error.message).join('\n')}`,
    );
  }
  await fs.writeFile(filePath, code);
}

/**
 * Updates the tsconfig file data in place to include the new package.
 *
 * @param packageData - = The package data.
 * @param monorepoFileData - The monorepo file data.
 */
function updateTsConfigs(
  packageData: PackageData,
  monorepoFileData: MonorepoFileData,
): void {
  const { tsConfigBuild } = monorepoFileData;

  tsConfigBuild.references.push({
    path: `./${path.basename(PACKAGES_PATH)}/${
      packageData.directoryName
    }/tsconfig.build.json`,
  });
  tsConfigBuild.references.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reads the template files and updates them with the specified package data.
 *
 * @param packageData - The package data.
 * @returns A map of file paths to processed template file contents.
 */
async function processTemplateFiles(
  packageData: PackageData,
): Promise<FileMap> {
  const result: FileMap = {};
  const templateFiles = await readAllFiles(PACKAGE_TEMPLATE_DIR);

  for (const [relativePath, content] of Object.entries(templateFiles)) {
    result[relativePath] = processTemplateContent(packageData, content);
  }

  return result;
}

/**
 * Processes the template file content by replacing placeholders with relevant values
 * from the specified package data.
 *
 * @param packageData - The package data.
 * @param content - The template file content.
 * @returns The processed template file content.
 */
function processTemplateContent(
  packageData: PackageData,
  content: string,
): string {
  const { name, description, currentYear } = packageData;

  return content.replace(allPlaceholdersRegex, (match) => {
    switch (match as Placeholder) {
      case Placeholder.CurrentYear:
        return currentYear;
      case Placeholder.PackageName:
        return name;
      case Placeholder.PackageDescription:
        return description;
      case Placeholder.PackageDirectoryName:
        return packageData.directoryName;
      /* istanbul ignore next: should be impossible */
      default:
        throw new Error(`Unknown placeholder: ${match}`);
    }
  });
}
