import { describe, it, expect } from 'vitest';

import { parseFirstStatement, textOf } from './statement.ts';

describe('parseFirstStatement', () => {
  it.each([
    ['an expression', '1 + 1;', 'ExpressionStatement'],
    ['a top-level await', 'await E(wallet).balance();', 'ExpressionStatement'],
    ['a declaration', 'const x = 1;', 'VariableDeclaration'],
    ['an import', 'import { a } from "b";', 'ImportDeclaration'],
    ['the first of two statements', 'f(); g();', 'ExpressionStatement'],
    ['a statement after a comment', 'f(); // note', 'ExpressionStatement'],
    ['a comment inside a statement', 'f(/* x */ 1);', 'ExpressionStatement'],
    ['a return inside an if', 'if (a) return 1;', 'IfStatement'],
  ])('parses %s', (_case, code, type) => {
    expect(parseFirstStatement(code)?.type).toBe(type);
  });

  it.each([
    ['a comment', '// note'],
    ['a comment before a statement', '/* note */ f();'],
  ])('returns undefined for %s', (_case, code) => {
    expect(parseFirstStatement(code)).toBeUndefined();
  });

  it.each([
    ['empty code', '', 'Expected a statement or a comment'],
    ['blank code', '   ', 'Expected a statement or a comment'],
    ['invalid code', 'const = 1;', 'Unexpected token'],
    ['invalid code after a statement', 'f(); const = 1;', 'Unexpected token'],
  ])('throws on %s', (_case, code, message) => {
    expect(() => parseFirstStatement(code)).toThrow(message);
  });
});

describe('textOf', () => {
  it("returns a node's source text", () => {
    const code = 'f(); g();';
    const node = parseFirstStatement(code);
    expect(node && textOf(node, code)).toBe('f();');
  });
});
