import { describe, it, expect } from 'vitest';

import { evadeCensorPlugin } from './evade-censor-plugin.ts';

type Chunk = { type: 'chunk'; fileName: string; code: string };

type GenerateBundle = (
  this: { error: (message: string) => never },
  options: unknown,
  bundle: Record<string, Chunk>,
) => Promise<void>;

const generateBundle = evadeCensorPlugin().generateBundle as GenerateBundle;

const context = {
  error: (message: string): never => {
    throw new Error(message);
  },
};

const render = async (code: string): Promise<string> => {
  const chunk: Chunk = { type: 'chunk', fileName: 'vat.js', code };
  await generateBundle.call(context, {}, { 'vat.js': chunk });
  return chunk.code;
};

// Evaluate a chunk that is a single expression statement.
const evaluate = (code: string): unknown =>
  // oxlint-disable-next-line typescript/no-implied-eval, no-new-func
  Function(`return ${code}`)();

describe('evadeCensorPlugin', () => {
  it.each([
    // `evadeCensor` would re-print this as `({ ...(a&& b)})`.
    ['a chunk without censored text', '({ ...a && b })'],
    ['a method named import', '({ import: (value) => value }).import(1)'],
  ])('leaves %s alone', async (_case, content) => {
    expect(await render(content)).toStrictEqual(content);
  });

  // Parenthesized, since a string statement on its own is a directive, which
  // the transform leaves alone.
  it.each([
    ['import() in a string', '("Trailing comma is not allowed in import()")'],
    ['import() in a template literal', '(`see import(x)`)'],
    ['an HTML comment opener in a string', '("<!-- x")'],
    ['an HTML comment closer in a string', '("x -->")'],
  ])('rewrites %s to equivalent text', async (_name, code) => {
    const rewritten = await render(code);
    expect(rewritten).not.toBe(code);
    expect(evaluate(rewritten)).toBe(evaluate(code));
  });

  it.each([
    [
      'an import() expression',
      'import("node:fs");',
      'contains an import() expression or an HTML comment token',
    ],
    // SES rejects these, but `evadeCensor` does not rewrite them.
    [
      'import /* in a string',
      '("see import /* x")',
      'contains an import() expression or an HTML comment token',
    ],
    [
      'import // in a string',
      '("see import // x")',
      'contains an import() expression or an HTML comment token',
    ],
    [
      'text the transform cannot rewrite',
      '({ "import(": 1 });',
      'contains text SES rejects, and rewriting it failed',
    ],
  ])('fails the build on %s', async (_name, code, message) => {
    await expect(render(code)).rejects.toThrow(`Chunk "vat.js" ${message}`);
  });
});
