import { parse } from 'acorn';
import type { Comment, ModuleDeclaration, Statement } from 'acorn';

export type StatementNode = Statement | ModuleDeclaration;

export type ParsedStatement<Node extends StatementNode = StatementNode> = {
  node: Node;
  text: string;
};

/**
 * Parse the first statement of some code. Parsing as a module allows a
 * top-level `await`. A `return` is allowed because the evaluator wraps a
 * control-flow statement in a function.
 *
 * @param code - The code to parse.
 * @returns The statement's node, or `undefined` if the code opens with a
 * comment.
 */
export const parseFirstStatement = (
  code: string,
): StatementNode | undefined => {
  const comments: Comment[] = [];
  const {
    body: [statement],
  } = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
    onComment: comments,
  });
  const [comment] = comments;
  if (comment && (!statement || comment.start < statement.start)) {
    return undefined;
  }
  if (!statement) {
    throw new SyntaxError(`Expected a statement or a comment: "${code}"`);
  }
  return statement;
};

/**
 * Get the source text of a node.
 *
 * @param node - The node.
 * @param code - The code it was parsed from.
 * @returns The node's text.
 */
export const textOf = (
  node: { start: number; end: number },
  code: string,
): string => code.slice(node.start, node.end);
