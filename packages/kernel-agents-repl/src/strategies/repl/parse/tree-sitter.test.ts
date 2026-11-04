/**
 * This suite declares expected AST nodes for various JavaScript expressions.
 */
import '@ocap/repo-tools/test-utils/mock-endoify';
import { describe, it, expect } from 'vitest';

import { firstStatement } from './syntax-tree.ts';
import { makeTreeSitterParser } from './tree-sitter.ts';

describe('makeTreeSitterParser', () => {
  const parser = makeTreeSitterParser();

  it.each([
    // An array of expected proposals from the LLM and their AST types.
    ['const a = 1;', 'lexical_declaration'],
    ['let { b } = { b: 2 };', 'lexical_declaration'],
    ['var [ c ] = [ 3 ];', 'variable_declaration'],
    ['const x = () => 42;', 'lexical_declaration'],
    ['function y() { return 42; }', 'function_declaration'],
    ['function* z() { yield 42; }', 'generator_function_declaration'],
    ['1 + 1', 'expression_statement'],
    ['for (let i = 0; i < 4; i++) { console.log(i); }', 'for_statement'],
    ['(function() { return 42; })()', 'expression_statement'],
    // Note: the below case becomes a function_declaration once the body closes.
    ['function test() {', 'expression_statement'],
    ['let length = 11, width = 47, height = 63;', 'lexical_declaration'],
    ['// This is a comment', 'comment'],
    ['import { foo } from "@ocap/abilities";', 'import_statement'],
  ])('parses `%s` as %s', async (expression: string, expectedType: string) => {
    const program = await parser.parse(expression);
    expect(program.text).toStrictEqual(expression);
    expect(program.type).toBe('program');
    expect(program.children).toHaveLength(1);
    const statement = firstStatement(program);
    expect(statement.text).toStrictEqual(expression);
    expect(statement.type).toBe(expectedType);
  });

  it('copies a node into plain data', async () => {
    const program = await parser.parse('x;');
    expect(program).toStrictEqual({
      type: 'program',
      text: 'x;',
      isNamed: true,
      children: [
        {
          type: 'expression_statement',
          text: 'x;',
          isNamed: true,
          children: [
            { type: 'identifier', text: 'x', isNamed: true, children: [] },
            { type: ';', text: ';', isNamed: false, children: [] },
          ],
        },
      ],
    });
  });
});
