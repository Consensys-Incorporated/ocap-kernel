import type { JsonRpcMessage } from '@metamask/kernel-utils';
import type { DuplexStream } from '@metamask/streams';
import { vi, describe, it, expect } from 'vitest';

import {
  isKernelMessage,
  isLoggerMessage,
  lser,
  lunser,
  splitLoggerStream,
} from './stream.ts';

const mocks = vi.hoisted(() => ({
  split: vi.fn((a) => [a, a]),
}));

vi.mock('@ocap/streams', () => ({
  split: mocks.split,
}));

describe('serialization', () => {
  it.each`
    description                              | logEntry
    ${'with message and data'}               | ${{ level: 'info', tags: ['test'], message: 'test', data: ['test'] }}
    ${'with message but no data'}            | ${{ level: 'info', tags: ['test'], message: 'test' }}
    ${'with no message or data'}             | ${{ level: 'info', tags: ['test'] }}
    ${'message and falsey data (0)'}         | ${{ level: 'log', tags: ['test'], message: 'foo', data: [0] }}
    ${'message and falsey data (false)'}     | ${{ level: 'log', tags: ['test'], message: 'foo', data: [false] }}
    ${'message and falsey data (null)'}      | ${{ level: 'log', tags: ['test'], message: 'foo', data: [null] }}
    ${'message and falsey data (undefined)'} | ${{ level: 'log', tags: ['test'], message: 'foo', data: [undefined] }}
  `('round-trips a log entry $description', ({ logEntry }) => {
    const serialized = lser(logEntry);
    const deserialized = lunser(serialized);
    // We want deep equals for testing missing versus undefined properties.
    // oxlint-disable-next-line vitest/valid-expect
    expect(deserialized).to.deep.equal(logEntry);
  });
});

const validParams = ['logger', 'info', ['test']];
const invalidParams = ['log', 'test'];
const unserializableParams = [() => undefined];

const asJsonRpcMethod = (method: string, params: unknown) => ({
  method,
  params,
  jsonrpc: '2.0',
});

describe('isLoggerMessage', () => {
  it.each`
    description                | value                                              | expectation
    ${'valid params'}          | ${asJsonRpcMethod('notify', validParams)}          | ${true}
    ${'invalid params'}        | ${asJsonRpcMethod('notify', invalidParams)}        | ${false}
    ${'unserializable params'} | ${asJsonRpcMethod('notify', unserializableParams)} | ${false}
    ${'invalid method'}        | ${asJsonRpcMethod('ping', null)}                   | ${false}
  `('returns $expectation for $description', ({ value, expectation }) => {
    expect({ result: isLoggerMessage(value), value }).toStrictEqual({
      result: expectation,
      value,
    });
  });
});

describe('isKernelMessage', () => {
  it.each`
    description        | value                                     | expectation
    ${'kernel method'} | ${asJsonRpcMethod('ping', null)}          | ${true}
    ${'logger method'} | ${asJsonRpcMethod('notify', validParams)} | ${false}
  `('returns $expectation for $description', ({ value, expectation }) => {
    expect({ result: isKernelMessage(value), value }).toStrictEqual({
      result: expectation,
      value,
    });
  });
});

describe('splitLoggerStream', () => {
  it('splits a stream into a kernel stream and a logger stream', () => {
    const stream = {
      [Symbol.iterator]: vi.fn(() => stream),
      next: vi.fn(() => ({ done: true, value: undefined })),
    } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>;
    const { kernelStream, loggerStream } = splitLoggerStream(stream);
    expect(mocks.split).toHaveBeenCalledWith(
      stream,
      expect.any(Function),
      expect.any(Function),
    );
    expect(kernelStream).toStrictEqual(stream);
    expect(loggerStream).toStrictEqual(stream);
  });
});
