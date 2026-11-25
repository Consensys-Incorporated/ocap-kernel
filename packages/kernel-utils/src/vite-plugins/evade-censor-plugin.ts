import { evadeCensor } from '@endo/evasive-transform';
import type { Plugin } from 'vite';

// The source text SES rejects, even inside a string or regular expression: its
// `importPattern` and `htmlCommentPattern` from `ses/src/transforms.js`.
const CENSORED = /(?:^|[^.]|\.\.\.)\bimport\s*(?:\(|\/[/*])|<!--|-->/u;

/**
 * Rolldown plugin that rewrites text SES would reject, such as `"import()"` in a
 * dependency's error message, into equivalent text that it accepts. A real
 * `import()` expression is left as it is, so the build fails on it here rather
 * than the vat failing to start.
 *
 * It edits the chunks in `generateBundle` because Rolldown folds the rewritten
 * strings back together after `renderChunk`. `evadeCensor` re-prints the whole
 * chunk, so it runs only on a chunk that matches.
 *
 * @returns A Rolldown plugin.
 */
export function evadeCensorPlugin(): Plugin {
  return {
    name: 'ocap-kernel:evade-censor',
    async generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !CENSORED.test(output.code)) {
          continue;
        }
        let code: string;
        try {
          ({ code } = await evadeCensor(output.code, {
            sourceType: 'script',
          }));
        } catch (error) {
          this.error(
            `Chunk "${output.fileName}" contains text SES rejects, and rewriting it failed: ${String(error)}`,
          );
        }
        if (CENSORED.test(code)) {
          this.error(
            `Chunk "${output.fileName}" contains an import() expression or an HTML comment token, which SES rejects`,
          );
        }
        output.code = code;
      }
    },
  };
}
