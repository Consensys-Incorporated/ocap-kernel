// @ts-check
// This file is used to define, among other configuration, rules that Yarn will
// execute when you run `yarn constraints`. These rules primarily check the
// manifests of each package in the monorepo to ensure they follow a standard
// format, but also check the presence of certain files as well.

// The jsdoc plugin complains that this type is undefined
/* global RegExpMatchArray */

const { defineConfig } = require('@yarnpkg/types');
const { get } = require('lodash');
const { readFile } = require('node:fs/promises');
const { basename, resolve } = require('node:path');
const { inspect } = require('node:util');
const semver = require('semver');

// Packages that do not have an entrypoint, types, or sideEffects
const entrypointExceptions = ['shims', 'streams'];
// Packages that do not have typedoc
const typedocExceptions = [
  'extension',
  'kernel-test',
  'lint-config',
  'omnium-gatherum',
  'repo-tools',
];
// Packages that do not enforce the standard build script
const buildExceptions = ['create-package', 'kernel-cli', 'repo-tools'];
// Packages that do not have tests
const noTests = [];
// Packages that do not export a `package.json` file
const noPackageJsonExport = ['extension', 'omnium-gatherum'];
// Packages that have weird exports
const exportsExceptions = ['kernel-cli', 'kernel-shims'];
// Packages that have weird files
const filesExceptions = [
  'kernel-browser-runtime',
  'kernel-store',
  'kernel-utils',
  'ocap-kernel',
  'streams',
];

/**
 * Aliases for the Yarn type definitions, to make the code more readable.
 *
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Context['Yarn']} Yarn
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Dependency} Dependency
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.DependencyType} DependencyType
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Workspace} Workspace
 */

module.exports = defineConfig({
  async constraints({ Yarn }) {
    const rootWorkspace = Yarn.workspace({ cwd: '.' });
    if (rootWorkspace === null) {
      throw new Error('Could not find root workspace');
    }

    const repositoryUri = rootWorkspace.manifest.repository.url.replace(
      /\.git$/u,
      '',
    );

    for (const workspace of Yarn.workspaces()) {
      const workspaceBasename = getWorkspaceBasename(workspace);
      const isChildWorkspace = workspace.cwd !== '.';
      const isPrivate = workspace.manifest.private === true;
      const dependenciesByIdentAndType = getDependenciesByIdentAndType(
        Yarn.dependencies({ workspace }),
      );

      // All packages must have a name
      expectWorkspaceField(workspace, 'name');

      if (isChildWorkspace) {
        // All non-root packages must have a name that matches its directory
        expectWorkspaceField(
          workspace,
          'name',
          `@${isPrivate ? 'ocap' : 'metamask'}/${workspaceBasename}`,
        );

        // All non-root packages must have a version.
        expectWorkspaceField(workspace, 'version');

        // // All non-root packages must have a description that does not end with a period.
        expectWorkspaceDescription(workspace);

        if (!isPrivate) {
          // All non-root packages must have the same set of NPM keywords.
          expectWorkspaceField(workspace, 'keywords', [
            'MetaMask',
            'object capabilities',
            'ocap',
          ]);

          // All non-root packages must have a homepage URL that includes its name.
          expectWorkspaceField(
            workspace,
            'homepage',
            `${repositoryUri}/tree/main/packages/${workspaceBasename}#readme`,
          );

          // All non-root packages must have a URL for reporting bugs that points
          // to the Issues page for the repository.
          expectWorkspaceField(
            workspace,
            'bugs.url',
            `${repositoryUri}/issues`,
          );
        }

        // All non-root packages must specify this monorepo's Git repository.
        expectWorkspaceField(workspace, 'repository.type', 'git');
        expectWorkspaceField(
          workspace,
          'repository.url',
          `${repositoryUri}.git`,
        );

        if (isPrivate) {
          // Non-published packages should not have a license.
          workspace.unset('license');
        } else {
          // Published packages must have a license.
          expectWorkspaceLicense(workspace);
        }

        if (!isPrivate) {
          // Non-private packages must not depend on private packages.
          expectNoPrivateWorkspaceProductionDependencies(Yarn, workspace);
          // Non-private packages must not use the patch: protocol in production deps.
          expectNoPatchProtocolProductionDependencies(Yarn, workspace);
        }

        if (!isPrivate && !exportsExceptions.includes(workspaceBasename)) {
          // The entrypoints for all published packages must be the same.
          workspace.unset('module');
          expectWorkspaceField(workspace, 'main', './dist/index.js');
          expectWorkspaceField(workspace, 'types', './dist/index.d.ts');

          // The exports for all published packages must be the same.
          expectWorkspaceField(
            workspace,
            'exports["."].default',
            './dist/index.js',
          );
          expectWorkspaceField(
            workspace,
            'exports["."].types',
            './dist/index.d.ts',
          );

          // Published packages must not have side effects.
          expectWorkspaceField(workspace, 'sideEffects', false);

          // All non-root package must have valid "changelog:update" and
          // "changelog:validate" scripts.
          expectCorrectWorkspaceChangelogScripts(workspace);
        }

        // Non-published packages must not specify the following keys except from the ones that are exempted
        if (isPrivate && !entrypointExceptions.includes(workspaceBasename)) {
          workspace.unset('module');
          workspace.unset('main');
          workspace.unset('types');
          workspace.unset('sideEffects');
        }

        // All non-root packages must export a `package.json` file except for the ones that are exempted
        if (!noPackageJsonExport.includes(workspaceBasename)) {
          expectWorkspaceField(
            workspace,
            'exports["./package.json"]',
            './package.json',
          );
        }

        if (filesExceptions.includes(workspaceBasename)) {
          expectWorkspaceField(workspace, 'files');
        } else if (
          !isPrivate ||
          entrypointExceptions.includes(workspaceBasename)
        ) {
          // The list of files included in all non-root packages must only include
          // files generated during the build process.
          expectWorkspaceField(workspace, 'files', ['dist/']);
        }

        if (!typedocExceptions.includes(workspaceBasename)) {
          // All non-root packages must have the same "build:docs" script.
          expectWorkspaceField(
            workspace,
            'scripts.build:docs',
            'npx -y -p typedoc@0.28.20 -p typescript@6.0.3 typedoc',
          );
        }

        // All packages except the root must have a "clean" script that includes ./logs.
        expectWorkspaceField(workspace, 'scripts.clean', (currentValue) =>
          typeof currentValue === 'string' && !currentValue.includes('./logs')
            ? `${currentValue} ./logs`
            : currentValue,
        );

        // No non-root packages may have a "prepack" script.
        workspace.unset('scripts.prepack');

        // All packages except the root must have the same "lint" scripts.
        expectWorkspaceField(
          workspace,
          'scripts.lint',
          'yarn lint:oxlint && yarn lint:oxfmt && yarn constraints && yarn lint:dependencies',
        );
        expectWorkspaceField(
          workspace,
          'scripts.lint:dependencies',
          'depcheck --quiet',
        );
        expectWorkspaceField(
          workspace,
          'scripts.lint:fix',
          'yarn lint:oxlint --fix && oxfmt . && yarn constraints --fix && yarn lint:dependencies',
        );
        expectWorkspaceField(
          workspace,
          'scripts.lint:oxfmt',
          'oxfmt --check .',
        );
        expectWorkspaceField(workspace, 'scripts.lint:oxlint', 'oxlint .');
        workspace.unset('scripts.lint:eslint');
        workspace.unset('scripts.lint:misc');

        // All non-root packages must have the same "test" script.
        if (!noTests.includes(workspaceBasename)) {
          expectWorkspaceField(
            workspace,
            'scripts.test',
            'vitest run --config vitest.config.ts',
          );
          expectWorkspaceField(
            workspace,
            'scripts.test:clean',
            'yarn test --no-cache --coverage.clean',
          );
          expectWorkspaceField(
            workspace,
            'scripts.test:dev',
            'yarn test --mode development',
          );
          expectWorkspaceField(
            workspace,
            'scripts.test:dev:quiet',
            'yarn test:dev --reporter @ocap/repo-tools/vitest-reporters/silent',
          );
          expectWorkspaceField(
            workspace,
            'scripts.test:verbose',
            'yarn test --reporter verbose',
          );
          expectWorkspaceField(
            workspace,
            'scripts.test:watch',
            'vitest --config vitest.config.ts',
          );
        }

        expectWorkspaceField(
          workspace,
          'scripts.test:types',
          'tsc --project tsconfig.json',
        );
      }

      if (!buildExceptions.includes(workspaceBasename)) {
        const enforceTsc = (currentValue) =>
          typeof currentValue === 'string' &&
          currentValue.includes('tsc --project')
            ? `rimraf --glob ./dist './*.tsbuildinfo' && tsc --project tsconfig.build.json`
            : currentValue;

        expectWorkspaceField(workspace, 'scripts.build', enforceTsc);
        expectOptionalWorkspaceField(
          workspace,
          'scripts.build:lib',
          enforceTsc,
        );
      }

      if (!isChildWorkspace) {
        // The root package must not specify exports.
        workspace.unset('exports');

        // The root workspace is private and never published; the empty list
        // keeps that explicit.
        expectWorkspaceField(workspace, 'files', []);
      }

      // Ensure all dependency ranges are recognizable
      expectValidVersionRanges(Yarn, workspace);

      // Ensure dependency ranges are synchronized across the monorepo
      expectSynchronizedRanges(Yarn, workspace);

      // Ensure dependencies are not duplicated across dependency types
      expectUniqueDependencyTypes(Yarn, workspace);

      // If one workspace package lists another workspace package within
      // `peerDependencies`, the dependency range must satisfy the current
      // version of that package.
      expectUpToDateWorkspacePeerDependencies(Yarn, workspace);

      // No dependency may be listed under both `dependencies` and
      // `devDependencies`.
      expectDependenciesNotInBothProdAndDev(
        workspace,
        dependenciesByIdentAndType,
      );

      // The root workspace (and only the root workspace) must specify the Yarn
      // version required for development.
      if (isChildWorkspace) {
        workspace.unset('packageManager');
      } else {
        expectWorkspaceField(workspace, 'packageManager', 'yarn@4.18.1');
      }

      expectWorkspaceField(workspace, 'engines.node', '>=22');

      // All non-root public packages should be published to the NPM registry;
      // all non-root private packages should not.
      if (isPrivate) {
        workspace.unset('publishConfig');
      } else {
        expectWorkspaceField(workspace, 'publishConfig.access', 'public');
        expectWorkspaceField(
          workspace,
          'publishConfig.registry',
          'https://registry.npmjs.org/',
        );
      }

      if (!isPrivate) {
        // All non-root packages must have a valid README.md file.
        await expectReadme(workspace, workspaceBasename);
      }
    }

    // All version ranges in `dependencies` and `devDependencies` for the same
    // dependency across the monorepo must be the same.
    expectConsistentDependenciesAndDevDependencies(Yarn);
  },
});

/**
 * Construct a nested map of dependencies. The inner layer categorizes
 * instances of the same dependency by its location in the manifest; the outer
 * layer categorizes the inner layer by the name of the dependency.
 *
 * @param {Dependency[]} dependencies - The list of dependencies to transform.
 * @returns {Map<string, Map<DependencyType, Dependency>>} The resulting map.
 */
function getDependenciesByIdentAndType(dependencies) {
  const dependenciesByIdentAndType = new Map();

  for (const dependency of dependencies) {
    const dependenciesForIdent = dependenciesByIdentAndType.get(
      dependency.ident,
    );

    if (dependenciesForIdent === undefined) {
      dependenciesByIdentAndType.set(
        dependency.ident,
        new Map([[dependency.type, dependency]]),
      );
    } else {
      dependenciesForIdent.set(dependency.type, dependency);
    }
  }

  return dependenciesByIdentAndType;
}

/**
 * Construct a nested map of non-peer dependencies (`dependencies` and
 * `devDependencies`). The inner layer categorizes instances of the same
 * dependency by the version range specified; the outer layer categorizes the
 * inner layer by the name of the dependency itself.
 *
 * @param {Dependency[]} dependencies - The list of dependencies to transform.
 * @returns {Map<string, Map<string, Dependency[]>>} The resulting map.
 */
function getNonPeerDependenciesByIdent(dependencies) {
  const nonPeerDependenciesByIdent = new Map();

  for (const dependency of dependencies) {
    if (dependency.type === 'peerDependencies') {
      continue;
    }

    const dependencyRangesForIdent = nonPeerDependenciesByIdent.get(
      dependency.ident,
    );

    if (dependencyRangesForIdent === undefined) {
      nonPeerDependenciesByIdent.set(
        dependency.ident,
        new Map([[dependency.range, [dependency]]]),
      );
    } else {
      const dependenciesForDependencyRange = dependencyRangesForIdent.get(
        dependency.range,
      );

      if (dependenciesForDependencyRange === undefined) {
        dependencyRangesForIdent.set(dependency.range, [dependency]);
      } else {
        dependenciesForDependencyRange.push(dependency);
      }
    }
  }

  return nonPeerDependenciesByIdent;
}

/**
 * Get the basename of the workspace's directory. The workspace directory is
 * expected to be in the form `<directory>/<package-name>`, and this function
 * will extract `<package-name>`.
 *
 * @param {Workspace} workspace - The workspace.
 * @returns {string} The name of the workspace.
 */
function getWorkspaceBasename(workspace) {
  return basename(workspace.cwd);
}

/**
 * Get the absolute path to a file within the workspace.
 *
 * @param {Workspace} workspace - The workspace.
 * @param {string} path - The path to the file, relative to the workspace root.
 * @returns {string} The absolute path to the file.
 */
function getWorkspacePath(workspace, path) {
  return resolve(__dirname, workspace.cwd, path);
}

/**
 * Get the contents of a file within the workspace. The file is expected to be
 * encoded as UTF-8.
 *
 * @param {Workspace} workspace - The workspace.
 * @param {string} path - The path to the file, relative to the workspace root.
 * @returns {Promise<string>} The contents of the file.
 */
async function getWorkspaceFile(workspace, path) {
  return await readFile(getWorkspacePath(workspace, path), 'utf8');
}

/**
 * Attempts to access the given file to know whether the file exists.
 *
 * @param {Workspace} workspace - The workspace.
 * @param {string} path - The path to the file, relative to the workspace root.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function workspaceFileExists(workspace, path) {
  try {
    await getWorkspaceFile(workspace, path);
  } catch (error) {
    // No hasProperty() in here.

    if ('code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  return true;
}

/**
 * Expect that the workspace has the given field, and that it is a non-null
 * value. If the field is not present, or is null, this will log an error, and
 * cause the constraint to fail.
 *
 * If a value or enforcer function is provided, set the field to the value or
 * result of the enforcer function.
 *
 * @param {Workspace} workspace - The workspace to check.
 * @param {string} fieldName - The field to check.
 * @param {unknown} [enforcedValueOrFunction] - The value to set the field to, or
 * a function returning the value to set the field to.
 */
function expectWorkspaceField(
  workspace,
  fieldName,
  enforcedValueOrFunction = undefined,
) {
  const fieldValue = get(workspace.manifest, fieldName);

  if (enforcedValueOrFunction !== undefined) {
    workspace.set(
      fieldName,
      typeof enforcedValueOrFunction === 'function'
        ? enforcedValueOrFunction(fieldValue)
        : enforcedValueOrFunction,
    );
  } else if (fieldValue === undefined || fieldValue === null) {
    workspace.error(`Missing required field "${fieldName}".`);
  }
}

/**
 * If the workspace has the given field, set it to the result of the enforcer
 * function.
 *
 * @param {Workspace} workspace - The workspace to check.
 * @param {string} fieldName - The field to check.
 * @param {(value: unknown) => unknown} enforcerFunction -
 */
function expectOptionalWorkspaceField(workspace, fieldName, enforcerFunction) {
  const fieldValue = get(workspace.manifest, fieldName);

  if (fieldValue !== undefined && fieldValue !== null) {
    workspace.set(fieldName, enforcerFunction(fieldValue));
  }
}

/**
 * Expect that the workspace has a description, and that it is a non-empty
 * string. If the description is not present, or is null, this will log an
 * error, and cause the constraint to fail.
 *
 * This will also verify that the description does not end with a period.
 *
 * @param {Workspace} workspace - The workspace to check.
 */
function expectWorkspaceDescription(workspace) {
  expectWorkspaceField(workspace, 'description');

  const { description } = workspace.manifest;

  if (typeof description !== 'string') {
    workspace.error(
      `Expected description to be a string, but got ${typeof description}.`,
    );
    return;
  }

  if (description === '') {
    workspace.error(`Expected description not to be an empty string.`);
    return;
  }

  if (description.endsWith('.')) {
    workspace.set('description', description.slice(0, -1));
  }
}

/**
 * Expect that the workspace has a license file, and that the `license` field is
 * set.
 *
 * @param {Workspace} workspace - The workspace to check.
 */
async function expectWorkspaceLicense(workspace) {
  expectWorkspaceField(workspace, 'license', '(MIT OR Apache-2.0)');

  if (
    !(await workspaceFileExists(workspace, 'LICENSE.MIT')) ||
    !(await workspaceFileExists(workspace, 'LICENSE.APACHE2'))
  ) {
    workspace.error('Could not find LICENSE files');
  }
}

/**
 * Expect that the workspace has "changelog:update" and "changelog:validate"
 * scripts, and that these package scripts call a common script by passing the
 * name of the package as the first argument.
 *
 * @param {Workspace} workspace - The workspace to check.
 */
function expectCorrectWorkspaceChangelogScripts(workspace) {
  /**
   * @type {Record<string, { expectedStartString: string, script: string, match: RegExpMatchArray | null }>}
   */
  const scripts = ['update', 'validate'].reduce((obj, variant) => {
    const expectedStartString = `../../scripts/${variant}-changelog.sh ${workspace.manifest.name}`;
    const script = workspace.manifest.scripts[`changelog:${variant}`] ?? '';
    const match = script.match(new RegExp(`^${expectedStartString}(.*)$`, 'u'));
    return { ...obj, [variant]: { expectedStartString, script, match } };
  }, {});

  if (
    scripts.update.match &&
    scripts.validate.match &&
    scripts.update.match[1] !== scripts.validate.match[1]
  ) {
    workspace.error(
      'Expected package\'s "changelog:validate" and "changelog:update" scripts to pass the same arguments to their underlying scripts',
    );
  }

  for (const [
    variant,
    { expectedStartString, script, match },
  ] of Object.entries(scripts)) {
    expectWorkspaceField(workspace, `scripts.changelog:${variant}`);

    if (script !== '' && !match) {
      workspace.error(
        `Expected package's "changelog:${variant}" script to be or start with "${expectedStartString}", but it was "${script}".`,
      );
    }
  }
}

/**
 * Expect that if the workspace package lists another workspace package within
 * `peerDependencies`, the dependency range satisfies the current version of
 * that package.
 *
 * @param {Yarn} Yarn - The Yarn "global".
 * @param {Workspace} workspace - The workspace to check.
 */
function expectUpToDateWorkspacePeerDependencies(Yarn, workspace) {
  for (const dependency of Yarn.dependencies({ workspace })) {
    const dependencyWorkspace = Yarn.workspace({ ident: dependency.ident });

    if (
      dependencyWorkspace !== null &&
      dependency.type === 'peerDependencies'
    ) {
      const dependencyWorkspaceVersion = new semver.SemVer(
        dependencyWorkspace.manifest.version,
      );
      if (
        !semver.satisfies(
          dependencyWorkspace.manifest.version,
          dependency.range,
        )
      ) {
        expectWorkspaceField(
          workspace,
          `peerDependencies["${dependency.ident}"]`,
          `^${dependencyWorkspaceVersion.major}.0.0`,
        );
      }
    }
  }
}

/**
 * Expect that a workspace package does not list a dependency in both
 * `dependencies` and `devDependencies`.
 *
 * @param {Workspace} workspace - The workspace to check.
 * @param {Map<string, Map<DependencyType, Dependency>>} dependenciesByIdentAndType - Map of
 * dependency ident to dependency type and dependency.
 */
function expectDependenciesNotInBothProdAndDev(
  workspace,
  dependenciesByIdentAndType,
) {
  for (const [
    dependencyIdent,
    dependencyInstancesByType,
  ] of dependenciesByIdentAndType.entries()) {
    if (
      dependencyInstancesByType.size > 1 &&
      !dependencyInstancesByType.has('peerDependencies')
    ) {
      workspace.error(
        `\`${dependencyIdent}\` cannot be listed in both \`dependencies\` and \`devDependencies\``,
      );
    }
  }
}

/**
 * Ensure that the version ranges in the dependencies are valid.
 *
 * @param {Yarn} Yarn - The Yarn "global".
 * @param {Workspace} workspace - The workspace to check.
 */
function expectValidVersionRanges(Yarn, workspace) {
  const isValidVersionRange = (range) => {
    return (
      semver.validRange(range) ||
      range === 'workspace:^' ||
      range === 'workspace:~' ||
      range.startsWith('patch:')
    );
  };
  const dependencies = Yarn.dependencies({ workspace });
  dependencies.forEach((dep) => {
    if (!isValidVersionRange(dep.range)) {
      throw new Error(
        `Invalid version range for dependency ${dep.ident} in ${workspace.cwd}`,
      );
    }
  });
}

/**
 * Parse a version range into its modifier and version.
 * Strips the modifier (^ or ~) from the version.
 *
 * @param {string} versionRange - The version range to parse.
 * @returns {{ modifier: string, version: string }} The parsed components: modifier, version.
 */
function parseVersion(versionRange) {
  return versionRange.startsWith('^') || versionRange.startsWith('~')
    ? { modifier: versionRange[0], version: versionRange.slice(1) }
    : { modifier: '', version: versionRange };
}

/**
 * Compare two version ranges and determine if they are out of sync.
 * Compares only if the modifiers ("^", "~") are the same.
 *
 * @param {string} range1 - First version range.
 * @param {string} range2 - Second version range.
 * @returns {boolean} True if range1 is greater than range2.
 */
function versionRangeCompare(range1, range2) {
  const parsed1 = parseVersion(range1);
  const parsed2 = parseVersion(range2);

  // Only compare if modifiers are the same
  if (parsed1.modifier !== parsed2.modifier) {
    return false;
  }

  return semver.gt(parsed1.version, parsed2.version);
}

/**
 * Ensures all dependency ranges for a package are synchronized across the monorepo.
 * The least version range wins, and inconsistencies throw an error.
 *
 * @param {Yarn} Yarn - The Yarn "global".
 * @param {Workspace} workspace - The current workspace.
 */
function expectSynchronizedRanges(Yarn, workspace) {
  const dependencies = Yarn.dependencies({ workspace });

  dependencies.forEach((dep) => {
    const matchingDeps = Yarn.workspaces()
      .flatMap((ws) => Yarn.dependencies({ workspace: ws }))
      .filter((otherDep) => otherDep.ident === dep.ident);

    matchingDeps.forEach((otherDep) => {
      if (
        dep.range !== otherDep.range &&
        versionRangeCompare(dep.range, otherDep.range)
      ) {
        throw new Error(
          `Dependency ${dep.ident} version out of sync between ${workspace.cwd} and another workspace. Expected ${otherDep.range}, got ${dep.range}.`,
        );
      }
    });
  });
}

/**
 * Ensure that the dependency types are unique for a workspace.
 *
 * @param {Yarn} Yarn - The Yarn "global".
 * @param {Workspace} workspace - The workspace to check.
 */
function expectUniqueDependencyTypes(Yarn, workspace) {
  const dependencies = Yarn.dependencies({ workspace });
  const depMap = new Map();

  dependencies.forEach((dep) => {
    if (depMap.has(dep.ident)) {
      const existingType = depMap.get(dep.ident);
      const types = new Set([existingType, dep.type]);
      if (
        existingType !== dep.type &&
        !(types.has('peerDependencies') && types.has('devDependencies'))
      ) {
        throw new Error(
          `Dependency ${dep.ident} is listed under both ${existingType} and ${dep.type} in ${workspace.cwd}`,
        );
      }
    } else {
      depMap.set(dep.ident, dep.type);
    }
  });
}

/**
 * Ensure all version ranges for a dependency across the monorepo are the same.
 * Leaves conflict resolution to the user. `peerDependencies` are handled separately.
 *
 * @param {Yarn} Yarn - The Yarn "global".
 */
function expectConsistentDependenciesAndDevDependencies(Yarn) {
  const nonPeerDependenciesByIdent = getNonPeerDependenciesByIdent(
    Yarn.dependencies(),
  );

  for (const [
    dependencyIdent,
    dependenciesByRange,
  ] of nonPeerDependenciesByIdent.entries()) {
    const dependencyRanges = [...dependenciesByRange.keys()].sort();
    if (dependenciesByRange.size > 1) {
      for (const dependencies of dependenciesByRange.values()) {
        for (const dependency of dependencies) {
          dependency.error(
            `Expected version range for ${dependencyIdent} (in ${
              dependency.type
            }) to be consistent across monorepo. Pick one: ${inspect(
              dependencyRanges,
            )}`,
          );
        }
      }
    }
  }
}

/**
 * Expect that non-private workspace packages do not have production
 * dependencies (anything except `devDependencies`) using the `workspace:`
 * protocol that resolve to private packages.
 *
 * @param {Yarn} Yarn - The Yarn "global".
 * @param {Workspace} workspace - The workspace to check.
 */
function expectNoPrivateWorkspaceProductionDependencies(Yarn, workspace) {
  for (const dependency of Yarn.dependencies({ workspace })) {
    if (dependency.type === 'devDependencies') {
      continue;
    }

    if (!dependency.range.startsWith('workspace:')) {
      continue;
    }

    const dependencyWorkspace = Yarn.workspace({ ident: dependency.ident });
    if (
      dependencyWorkspace !== null &&
      dependencyWorkspace.manifest.private === true
    ) {
      dependency.error(
        `Non-private package "${workspace.manifest.name}" must not depend on private package "${dependency.ident}" in "${dependency.type}"`,
      );
    }
  }
}

/**
 * Expect that non-private workspace packages do not have production
 * dependencies using the `patch:` protocol. Patches are workspace-local and
 * are not bundled with published packages, making them unresolvable for
 * consumers.
 *
 * @param {Yarn} Yarn - The Yarn "global".
 * @param {Workspace} workspace - The workspace to check.
 */
function expectNoPatchProtocolProductionDependencies(Yarn, workspace) {
  for (const dependency of Yarn.dependencies({ workspace })) {
    if (dependency.type === 'devDependencies') {
      continue;
    }
    if (dependency.range.startsWith('patch:')) {
      dependency.error(
        `Non-private package "${workspace.manifest.name}" must not use the "patch:" protocol for "${dependency.ident}" in "${dependency.type}".`,
      );
    }
  }
}

/**
 * Expect that the workspace has a README.md file, and that it is a non-empty
 * string. The README.md is expected to:
 *
 * - Not contain template instructions (unless the workspace is the module
 * template itself).
 * - Match the version of Node.js specified in the `.nvmrc` file.
 *
 * @param {Workspace} workspace - The workspace to check.
 * @param {string} workspaceBasename - The name of the workspace.
 * @returns {Promise<void>}
 */
async function expectReadme(workspace, workspaceBasename) {
  const readme = await getWorkspaceFile(workspace, 'README.md');

  if (
    workspaceBasename !== 'metamask-module-template' &&
    readme.includes('## Template Instructions')
  ) {
    workspace.error(
      'The README.md contains template instructions. These instructions should be removed.',
    );
  }

  if (!readme.includes(`yarn add @metamask/${workspaceBasename}`)) {
    workspace.error(
      `The README.md does not contain an example of how to install the package using Yarn (\`yarn add @metamask/${workspaceBasename}\`). Please add an example.`,
    );
  }

  if (!readme.includes(`npm install @metamask/${workspaceBasename}`)) {
    workspace.error(
      `The README.md does not contain an example of how to install the package using npm (\`npm install @metamask/${workspaceBasename}\`). Please add an example.`,
    );
  }
}
