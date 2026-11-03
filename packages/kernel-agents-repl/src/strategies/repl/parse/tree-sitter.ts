import TreeSitter from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';

import type { SyntaxTree } from './syntax-tree.ts';

/**
 * Copy a tree-sitter node into plain data.
 *
 * @param node - The node to copy.
 * @returns The tree.
 */
export const fromSyntaxNode = (node: SyntaxNode): SyntaxTree => ({
  type: node.type,
  text: node.text,
  isNamed: node.isNamed,
  children: node.children.map(fromSyntaxNode),
});

/**
 * Make the native tree-sitter JavaScript parser.
 *
 * @returns The parser.
 */
export const makeNativeParser = (): TreeSitter => {
  const parser = new TreeSitter();
  parser.setLanguage(JavaScript as TreeSitter.Language);
  return parser;
};
