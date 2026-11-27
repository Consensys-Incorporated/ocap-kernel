import type {
  OutputChunk,
  Plugin as RolldownPlugin,
  RolldownOutput,
} from 'rolldown';
import { build } from 'vite';

import type { VatBundle } from '../vat-bundle.ts';
import { evadeCensorPlugin } from './evade-censor-plugin.ts';
import { exportMetadataPlugin } from './export-metadata-plugin.ts';
import { replaceNodeEnvPlugin } from './replace-node-env-plugin.ts';
import { stripCommentsPlugin } from './strip-comments-plugin.ts';

export type { VatBundle } from '../vat-bundle.ts';

/**
 * A Rolldown plugin that replaces dynamic `import()` calls with `Promise.resolve({})`.
 *
 * Rolldown does not support IIFE format when any module in the bundle graph
 * contains dynamic imports, even when `output.codeSplitting` is false.
 * Some third-party packages (e.g. viem) use lazy `await import(x)` inside
 * utility functions that vats never actually call. This plugin removes those
 * dynamic imports from the code so that Rolldown accepts the IIFE format.
 *
 * Pattern transformed:
 *   `import('specifier')` / `import("specifier")` / `` import(`specifier`) ``
 *   → `Promise.resolve({})`
 *
 * Only replaces calls with literal string specifiers. Dynamic expressions
 * like `import(variable)` are left untouched.
 *
 * @returns A Rolldown plugin.
 */
export function removeDynamicImportsPlugin(): RolldownPlugin {
  return {
    name: 'ocap-kernel:remove-dynamic-imports',
    transform(code, id) {
      if (!/\bimport\s*\(/u.test(code)) {
        return null;
      }

      const transformed = code.replace(
        /\bimport\s*\(\s*(['"`])[^'"`]+\1\s*\)/gu,
        'Promise.resolve({})',
      );

      if (/\bimport\s*\(/u.test(transformed)) {
        this.warn(
          `Module "${id}" contains dynamic import() expressions that could not ` +
            `be replaced (e.g. computed specifiers). Rolldown may reject IIFE output.`,
        );
      }

      if (transformed === code) {
        return null;
      }

      return { code: transformed, map: null };
    },
  };
}

// Rolldown has global state that is corrupted when multiple build() calls run
// concurrently with IIFE format. Serialize all bundleVat calls to avoid this.
let buildQueue: Promise<void> = Promise.resolve();

/**
 * Bundle a vat source file using vite.
 *
 * Produces an IIFE bundle that assigns exports to a `__vatExports__` global,
 * along with metadata about the bundle's exports and external dependencies.
 *
 * @param sourcePath - Absolute path to the vat entry point.
 * @returns The bundle object containing code and metadata.
 */
export async function bundleVat(sourcePath: string): Promise<VatBundle> {
  const metadataPlugin = exportMetadataPlugin();

  // Wait for any in-flight build to finish before starting ours, then
  // register a slot so the next caller waits for us.
  const prevQueue = buildQueue;
  let releaseLock!: () => void;
  buildQueue = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  let result: Awaited<ReturnType<typeof build>>;
  try {
    await prevQueue;
    result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: {
          entry: sourcePath,
          formats: ['iife'],
          name: '__vatExports__',
        },
        rolldownOptions: {
          output: {
            exports: 'named',
            codeSplitting: false,
          },
          plugins: [
            removeDynamicImportsPlugin(),
            replaceNodeEnvPlugin(),
            stripCommentsPlugin(),
            evadeCensorPlugin(),
            metadataPlugin,
          ],
        },
      },
    });
  } finally {
    releaseLock();
  }

  const output = Array.isArray(result) ? result[0] : result;
  const chunk = (output as RolldownOutput).output.find(
    (item): item is OutputChunk => item.type === 'chunk' && item.isEntry,
  );

  if (!chunk) {
    throw new Error(`Failed to produce bundle for ${sourcePath}`);
  }

  return {
    moduleFormat: 'iife',
    code: chunk.code,
    ...metadataPlugin.getMetadata(),
  };
}
