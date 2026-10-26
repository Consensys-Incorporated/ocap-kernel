import { format as oxfmtFormat } from 'oxfmt';
import { describe, expect, it, vi } from 'vitest';

import { htmlTrustedPrelude } from './html-trusted-prelude.ts';

vi.mock('oxfmt', async (importOriginal) => {
  const original = await importOriginal<typeof import('oxfmt')>();
  return { ...original, format: vi.fn(original.format) };
});

const transform = async (html: string): Promise<string> => {
  const { transformIndexHtml } = htmlTrustedPrelude() as unknown as {
    transformIndexHtml: (html: string) => Promise<string>;
  };
  return transformIndexHtml(html);
};

describe('htmlTrustedPrelude', () => {
  it('inserts the endoify script before the first script in the head', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Offscreen</title><script src="./offscreen.ts" type="module"></script></head><body></body></html>`;

    expect(await transform(html)).toBe(
      [
        '<!doctype html>',
        '<html>',
        '  <head>',
        '    <meta charset="utf-8" />',
        '    <title>Offscreen</title>',
        '    <script src="/endoify.js" type="module"></script>',
        '    <script src="./offscreen.ts" type="module"></script>',
        '  </head>',
        '  <body></body>',
        '</html>',
        '',
      ].join('\n'),
    );
  });

  it('appends the endoify script to a head without scripts', async () => {
    const html = `<!doctype html><html><head><title>Popup</title></head><body><div id="root"></div><script src="./popup.tsx" type="module"></script></body></html>`;

    expect(await transform(html)).toBe(
      [
        '<!doctype html>',
        '<html>',
        '  <head>',
        '    <title>Popup</title>',
        '    <script src="/endoify.js" type="module"></script>',
        '  </head>',
        '  <body>',
        '    <div id="root"></div>',
        '    <script src="./popup.tsx" type="module"></script>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    );
  });

  it.each([
    [
      'endoify.ts',
      '<html><head><script src="endoify.ts"></script></head></html>',
      'HTML document should not reference "endoify.ts" directly',
    ],
    [
      'endoify.js',
      '<html><head><script src="/endoify.js"></script></head></html>',
      'HTML document already references endoify script',
    ],
  ])('throws if the document references %s', async (_name, html, message) => {
    await expect(transform(html)).rejects.toThrow(message);
  });

  it.each([
    [
      'its codeframe',
      { message: 'Unexpected token', codeframe: '  x Unexpected token\n' },
      '  x Unexpected token\n',
    ],
    [
      'its message',
      { message: 'Unexpected token', codeframe: null },
      'Unexpected token',
    ],
  ])(
    'throws instead of emitting HTML if formatting fails, showing %s',
    async (_name, error, shown) => {
      vi.mocked(oxfmtFormat).mockResolvedValueOnce({
        code: '<html></html>',
        errors: [error],
      } as unknown as Awaited<ReturnType<typeof oxfmtFormat>>);
      const html = `<!doctype html><html><head><title>Popup</title></head><body></body></html>`;

      await expect(transform(html)).rejects.toThrow(
        `Failed to format HTML document:\n${shown}`,
      );
    },
  );
});
