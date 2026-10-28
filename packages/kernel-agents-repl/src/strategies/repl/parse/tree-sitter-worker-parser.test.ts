import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SyntaxTree } from './syntax-tree.ts';
import type { ParseRequest, ParseResponse } from './tree-sitter-worker.ts';
import { makeTreeSitterWorkerParser } from './tree-sitter-worker-parser.ts';

type Listener = (event: unknown) => void;

const { MockWorker, workers } = vi.hoisted(() => {
  class MockWorker {
    readonly url: URL;

    readonly listeners = new Map<string, Listener>();

    readonly posted: ParseRequest[] = [];

    readonly terminate = vi.fn(async () => 0);

    readonly unref = vi.fn();

    constructor(url: URL) {
      this.url = url;
      workers.push(this);
    }

    on(event: string, listener: Listener): this {
      this.listeners.set(event, listener);
      return this;
    }

    postMessage(request: ParseRequest): void {
      this.posted.push(request);
    }

    emit(event: string, payload: unknown): void {
      this.listeners.get(event)?.(payload);
    }
  }
  const workers: MockWorker[] = [];
  return { MockWorker, workers };
});

vi.mock('node:worker_threads', () => ({ Worker: MockWorker }));

type MockWorker = InstanceType<typeof MockWorker>;

const tree: SyntaxTree = {
  type: 'program',
  text: '',
  isNamed: true,
  children: [],
};

describe('makeTreeSitterWorkerParser', () => {
  beforeEach(() => {
    workers.length = 0;
  });

  it('starts the built worker script without holding the process open', () => {
    makeTreeSitterWorkerParser();
    const [worker] = workers as [MockWorker];
    expect(worker.url.pathname).toMatch(
      /\/dist\/strategies\/repl\/parse\/tree-sitter-worker\.js$/u,
    );
    expect(worker.unref).toHaveBeenCalled();
  });

  it('resolves each parse with its own response', async () => {
    const parser = makeTreeSitterWorkerParser();
    const [worker] = workers as [MockWorker];
    const first = parser.parse('a;');
    const second = parser.parse('b;');
    expect(worker.posted).toStrictEqual([
      { id: 0, code: 'a;' },
      { id: 1, code: 'b;' },
    ]);
    const response: ParseResponse = { id: 1, tree };
    worker.emit('message', response);
    worker.emit('message', { id: 0, tree: { ...tree, text: 'a;' } });
    expect(await second).toBe(tree);
    expect(await first).toStrictEqual({ ...tree, text: 'a;' });
  });

  it('rejects a parse the worker could not do', async () => {
    const parser = makeTreeSitterWorkerParser();
    const [worker] = workers as [MockWorker];
    const parse = parser.parse('a;');
    worker.emit('message', { id: 0, error: 'bad input' });
    await expect(parse).rejects.toThrow('bad input');
  });

  it('ignores a response to an unknown request', () => {
    makeTreeSitterWorkerParser();
    const [worker] = workers as [MockWorker];
    expect(() => worker.emit('message', { id: 42, tree })).not.toThrow();
  });

  it.each([
    ['error', new Error('worker crashed'), 'worker crashed'],
    ['exit', 1, 'Parser worker exited'],
  ])(
    'rejects pending parses when the worker %ss',
    async (event, payload, message) => {
      const parser = makeTreeSitterWorkerParser();
      const [worker] = workers as [MockWorker];
      const parse = parser.parse('a;');
      worker.emit(event, payload);
      await expect(parse).rejects.toThrow(message);
    },
  );

  it('terminates the worker', async () => {
    const parser = makeTreeSitterWorkerParser();
    const [worker] = workers as [MockWorker];
    await parser.terminate();
    expect(worker.terminate).toHaveBeenCalled();
  });
});
