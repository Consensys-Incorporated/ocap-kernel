/**
 * The worker thread behind `makeTreeSitterWorkerParser`: owns the native
 * tree-sitter parser in a realm that never runs lockdown, and answers each
 * `{ id, code }` request with `{ id, tree }` or `{ id, error }`.
 */
import { parentPort } from 'node:worker_threads';

import { fromSyntaxNode, makeNativeParser } from './tree-sitter.ts';

export type ParseRequest = { id: number; code: string };
export type ParseResponse =
  | { id: number; tree: ReturnType<typeof fromSyntaxNode>; error?: never }
  | { id: number; tree?: never; error: string };

/**
 * Serve parse requests from a message port until it closes.
 *
 * @param port - The port to serve, normally the worker's parent port.
 */
export const serveParser = (port: {
  on: (event: 'message', listener: (request: ParseRequest) => void) => unknown;
  postMessage: (response: ParseResponse) => void;
}): void => {
  const parser = makeNativeParser();
  port.on('message', ({ id, code }) => {
    try {
      port.postMessage({
        id,
        tree: fromSyntaxNode(parser.parse(code).rootNode),
      });
    } catch (error) {
      port.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};

if (parentPort) {
  serveParser(parentPort);
}
