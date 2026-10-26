/**
 * The monorepo files that need to be parsed or modified.
 */
export const MonorepoFile = {
  TsConfigBuild: 'tsconfig.build.json',
} as const;

export type MonorepoFile = (typeof MonorepoFile)[keyof typeof MonorepoFile];

/**
 * Placeholder values in package template files that need to be replaced with
 * actual values corresponding to the new package.
 */
export const Placeholder = {
  CurrentYear: 'CURRENT_YEAR',
  PackageName: '@ocap/template-package',
  PackageDescription: 'PACKAGE_DESCRIPTION',
  PackageDirectoryName: 'template-package',
} as const;

export type Placeholder = (typeof Placeholder)[keyof typeof Placeholder];
