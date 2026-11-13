import type { Writer } from '@metamask/streams';
import type { AbortableAsyncIterator } from 'ollama';
import { vi } from 'vitest';
import type { Mocked } from 'vitest';

/**
 * Creates a mock @metamask/streams Writer that can be used to test the stream functionality.
 *
 * @returns A mock stream that can async iterate and always yields undefined.
 */
export const mockStream = (): Mocked<Writer<string>> => {
  const stream: Mocked<Writer<string>> = {
    next: vi.fn().mockResolvedValue(undefined),
    return: vi.fn().mockResolvedValue(undefined),
    throw: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: vi.fn(() => stream),
  };
  return stream;
};

/**
 * Creates a mock @ollama/AbortableAsyncIterator that can be used to test the stream functionality.
 *
 * @param responses - The responses to yield.
 * @param doneCallback - The callback to call when the iterator is done.
 * @returns A mock abortable async iterator that yields each response one by one, and then calls the done callback.
 */
export const makeMockAbortableAsyncIterator = <Content extends object>(
  responses: Content[],
  doneCallback?: () => void,
) => {
  let didAbort = false;
  const itr = (async function* mockGenerate() {
    for (const response of responses) {
      yield response;
      if (didAbort) {
        break;
      }
    }
    doneCallback?.();
  })();
  return {
    itr,
    doneCallback,
    abort: () => (didAbort = true),
    [Symbol.asyncIterator]: () => itr,
  } as unknown as AbortableAsyncIterator<Content>;
};

const encoder = new TextEncoder();

/**
 * Creates a mock ReadableStream for testing.
 *
 * @param chunks - The chunks to enqueue.
 * @returns A mock readable stream that yields each chunk one by one, and then closes.
 */
export const mockReadableStream = (chunks: object[]) =>
  // ReadableStream is experimental in Node 20, but this case works.
  new ReadableStream<object>({
    start(controller) {
      for (const chunk of chunks.slice(0, -1)) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              ...chunk,
              done: false,
            }),
          ),
        );
      }
      controller.enqueue(
        encoder.encode(
          JSON.stringify({
            ...chunks[chunks.length - 1],
            done: true,

            done_reason: 'stop',
          }),
        ),
      );
      controller.close();
    },
  });
