import { Worker } from 'node:worker_threads';

import type { Parser, SyntaxTree } from './syntax-tree.ts';
import type { ParseRequest, ParseResponse } from './tree-sitter-worker.ts';

/**
 * The built worker script. `src` and `dist` mirror each other, so the path
 * resolves to the same file whether this module runs from either.
 */
const WORKER_URL = new URL(
  '../../../../dist/strategies/repl/parse/tree-sitter-worker.js',
  import.meta.url,
);

export type WorkerParser = Parser & {
  /** Stop the worker. Pending parses reject. */
  terminate: () => Promise<void>;
};

/**
 * Make a JavaScript parser backed by the native tree-sitter binding running in
 * a worker thread. The binding cannot initialize in a locked-down realm, so a
 * host that has run lockdown (any production host, and the kernel test
 * harness) keeps it in a worker and sends each parse across. Offer the result
 * to vats with `makeKernelParserService`.
 *
 * @returns The parser.
 */
export const makeTreeSitterWorkerParser = (): WorkerParser => {
  const worker = new Worker(WORKER_URL);
  worker.unref();

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (tree: SyntaxTree) => void; reject: (error: Error) => void }
  >();

  const rejectAll = (error: Error): void => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  worker.on('message', ({ id, tree, error }: ParseResponse) => {
    const request = pending.get(id);
    pending.delete(id);
    if (!request) {
      return;
    }
    if (tree) {
      request.resolve(tree);
    } else {
      request.reject(new Error(error));
    }
  });
  worker.on('error', rejectAll);
  worker.on('exit', () => rejectAll(new Error('Parser worker exited')));

  return harden({
    parse: async (code: string): Promise<SyntaxTree> =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        const request: ParseRequest = { id, code };
        worker.postMessage(request);
      }),
    terminate: async (): Promise<void> => {
      await worker.terminate();
    },
  });
};
