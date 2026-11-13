import { load as loadHtml } from 'cheerio';
import { format as oxfmtFormat } from 'oxfmt';
import type { Plugin as VitePlugin } from 'vite';

import { loadOxfmtConfig } from '../build-utils/oxfmt-config.ts';

/**
 * Vite plugin to insert the endoify script before the first script in the head element.
 * Assumes that `endoify.js` is located in the root of the web app.
 *
 * @throws If the HTML document already references the endoify script or lacks the expected
 * structure.
 * @returns The Vite plugin.
 */
export function htmlTrustedPrelude(): VitePlugin {
  return {
    name: 'ocap-kernel:html-trusted-prelude',
    async transformIndexHtml(htmlString): Promise<string> {
      const htmlDoc = loadHtml(htmlString);

      if (htmlDoc('script[src="endoify.ts"]').length > 0) {
        throw new Error(
          `HTML document should not reference "endoify.ts" directly:\n${htmlString}`,
        );
      }

      if (htmlDoc('script[src*="endoify.js"]').length > 0) {
        throw new Error(
          `HTML document already references endoify script:\n${htmlString}`,
        );
      }

      if (htmlDoc('head').length !== 1) {
        throw new Error(
          `Expected HTML document with a single <head>. Received:\n${htmlString}`,
        );
      }

      const endoifyElement = `<script src="/endoify.js" type="module"></script>`;
      if (htmlDoc('head > script').length >= 1) {
        htmlDoc(endoifyElement).insertBefore('head:first script:first');
      } else {
        htmlDoc(endoifyElement).appendTo('head:first');
      }

      const { code, errors } = await oxfmtFormat(
        'index.html',
        htmlDoc.html(),
        await loadOxfmtConfig(),
      );
      if (errors.length > 0) {
        throw new Error(
          `Failed to format HTML document:\n${errors.map((error) => error.codeframe ?? error.message).join('\n')}`,
        );
      }
      return code;
    },
  };
}
