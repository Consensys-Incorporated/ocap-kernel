import TreeSitter from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';

import type { Parser, SyntaxTree } from './syntax-tree.ts';

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

/**
 * Make a JavaScript parser backed by the native tree-sitter binding in this
 * realm. Only for a realm that has not run lockdown: tree-sitter builds its
 * node classes with a direct `eval`, which a locked-down realm replaces with
 * a safe evaluator that cannot see the binding's module scope. A locked-down
 * host uses `makeTreeSitterWorkerParser` instead.
 *
 * @returns The parser.
 */
export const makeTreeSitterParser = (): Parser => {
  const parser = makeNativeParser();
  return harden({
    parse: async (code: string) => fromSyntaxNode(parser.parse(code).rootNode),
  });
};
