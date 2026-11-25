import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect } from 'vitest';

import { extractNamesFromDeclaration } from './identifiers.ts';
import { firstStatement } from './syntax-tree.ts';
import type { SyntaxTree } from './syntax-tree.ts';
import { makeTreeSitterParser } from './tree-sitter.ts';

const parser = makeTreeSitterParser();
const parseStatement = async (code: string): Promise<SyntaxTree> =>
  firstStatement(await parser.parse(code));

describe('extractNamesFromDeclaration', () => {
  it.each([
    ['function x() { return 1; }', ['x']],
    ['function* x() { yield 1; }', ['x']],
    ['async function x() { return 1; }', ['x']],
    ['async function* x() { yield 1; }', ['x']],
  ])('extracts declaration names from %s', async (text, expected) => {
    const statement = await parseStatement(text);
    expect(extractNamesFromDeclaration(statement)).toStrictEqual(expected);
  });

  describe.each(['const', 'let', 'var'])('variable declaration', (keyword) => {
    it.each([
      // Variable declaration
      [`${keyword} x = 1;`, ['x']],
      [`${keyword} x = foo(bar);`, ['x']],
      // Array destructuring
      [`${keyword} [x] = [foo()];`, ['x']],
      [`${keyword} [x, y] = [1, 2];`, ['x', 'y']],
      [`${keyword} [x,, y] = [1, 2, 3];`, ['x', 'y']],
      [`${keyword} [x, ...rest] = arr;`, ['x', 'rest']],
      [`${keyword} [x = 1, y] = arr;`, ['x', 'y']],
      // Object destructuring
      [`${keyword} { x } = { x: foo() };`, ['x']],
      [`${keyword} { x, y } = { x: 1, y: 2 };`, ['x', 'y']],
      [`${keyword} { x, ...rest } = obj;`, ['x', 'rest']],
      [`${keyword} { x: a, y: b } = obj;`, ['a', 'b']],
      [`${keyword} { x: { y, z } } = { x: { y: 1, z: 2 } };`, ['y', 'z']],
      [`${keyword} { x: { y, z: w } } = obj;`, ['y', 'w']],
      [`${keyword} { a = "b" } = { c: "d" };`, ['a']],
      // Arrow function definition
      [`${keyword} foo = (x) => x;`, ['foo']],
      [`${keyword} foo = ([x]) => x;`, ['foo']],
      [`${keyword} foo = ({x}) => x;`, ['foo']],
      [`${keyword} x = 1, y = 2, z = 3;`, ['x', 'y', 'z']],
    ])('extracts declaration names from %s', async (text, expected) => {
      const statement = await parseStatement(text);
      expect(extractNamesFromDeclaration(statement)).toStrictEqual(expected);
    });
  });

  it('throws for declaration with childless declarator', () => {
    expect(() =>
      // @ts-expect-error Destructive testing
      extractNamesFromDeclaration({
        type: 'lexical_declaration',
        children: [
          { type: 'const', text: 'const' },
          { type: 'declarator', children: [] },
          { type: ';', text: ';' },
        ] as unknown as [SyntaxTree, SyntaxTree, SyntaxTree],
      }),
    ).toThrow('Internal: Declarator missing pattern');
  });

  it.each([
    ['expression_statement', '1 + 1'],
    ['for_statement', 'for (let i = 0; i < 10; i++) { console.log(i); }'],
  ])('throws for %s', async (statementType, code) => {
    const statement = await parseStatement(code);
    expect(() => extractNamesFromDeclaration(statement)).toThrow(
      `Unknown declaration type: ${statementType}`,
    );
  });
});
