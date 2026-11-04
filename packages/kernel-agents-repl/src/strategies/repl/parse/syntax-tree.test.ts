import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect } from 'vitest';

import { firstStatement, toSExpression } from './syntax-tree.ts';
import type { SyntaxTree } from './syntax-tree.ts';

const leaf = (type: string, text: string, isNamed = true): SyntaxTree => ({
  type,
  text,
  isNamed,
  children: [],
});

const program: SyntaxTree = {
  type: 'program',
  text: 'const x = 1;',
  isNamed: true,
  children: [
    {
      type: 'lexical_declaration',
      text: 'const x = 1;',
      isNamed: true,
      children: [
        leaf('const', 'const', false),
        {
          type: 'variable_declarator',
          text: 'x = 1',
          isNamed: true,
          children: [
            leaf('identifier', 'x'),
            leaf('=', '=', false),
            leaf('number', '1'),
          ],
        },
        leaf(';', ';', false),
      ],
    },
  ],
};

describe('firstStatement', () => {
  it('returns the first child of a program', () => {
    expect(firstStatement(program)).toBe(program.children[0]);
  });

  it('throws for an empty program', () => {
    expect(() => firstStatement(leaf('program', ''))).toThrow(
      'Internal: Program has no statements: ""',
    );
  });
});

describe('toSExpression', () => {
  it('renders the named nodes', () => {
    expect(toSExpression(program)).toBe(
      '(program (lexical_declaration (variable_declarator (identifier) (number))))',
    );
  });
});
