/**
 * A concrete syntax tree as plain, passable data: the subset of a tree-sitter
 * `SyntaxNode` that the REPL reads. Being data rather than a live native
 * object, a tree can cross a kernel boundary, so the parser that produces it
 * may live in another vat or in the host.
 */
export type SyntaxTree = {
  /** The grammar node type, e.g. `lexical_declaration` or `identifier`. */
  type: string;
  /** The source text spanned by this node. */
  text: string;
  /** Whether the node is a named grammar symbol rather than punctuation. */
  isNamed: boolean;
  /** Child nodes in source order, including unnamed ones. */
  children: SyntaxTree[];
};

/**
 * A JavaScript parser: the REPL's only requirement of its syntax backend.
 * `parse` is asynchronous so that a parser can be a remote kernel service.
 */
export type Parser = {
  /**
   * Parse JavaScript source into a syntax tree rooted at a `program` node.
   *
   * @param code - The JavaScript source to parse.
   * @returns The tree.
   */
  parse: (code: string) => Promise<SyntaxTree>;
};

/**
 * The first statement of a program: the node the REPL treats as the action.
 *
 * @param program - A tree rooted at a `program` node.
 * @returns The first child.
 * @throws If the program has no statements.
 */
export const firstStatement = (program: SyntaxTree): SyntaxTree => {
  const [statement] = program.children;
  if (!statement) {
    throw new Error(`Internal: Program has no statements: "${program.text}"`);
  }
  return statement;
};

/**
 * Render a tree as an S-expression of its named nodes, in the style of
 * tree-sitter's `SyntaxNode.toString()`. For diagnostics.
 *
 * @param tree - The tree to render.
 * @returns The S-expression.
 */
export const toSExpression = (tree: SyntaxTree): string => {
  const named = tree.children.filter((child) => child.isNamed);
  return named.length === 0
    ? `(${tree.type})`
    : `(${tree.type} ${named.map(toSExpression).join(' ')})`;
};
