import type { SyntaxTree } from './syntax-tree.ts';
import { fromSyntaxNode, makeNativeParser } from './tree-sitter.ts';

const parser = makeNativeParser();

/**
 * Parse JavaScript into a syntax tree rooted at a `program` node.
 *
 * @param text - The text to parse.
 * @returns The tree.
 */
export const parse = (text: string): SyntaxTree =>
  fromSyntaxNode(parser.parse(text).rootNode);
