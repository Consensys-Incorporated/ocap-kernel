import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';
import type { Mocked } from 'vitest';

import { NodeWorkerDuplexStream } from './NodeWorkerStream.ts';
import type { NodePort, OnMessage } from './NodeWorkerStream.ts';
import { makeAck } from '../BaseDuplexStream.ts';
import type { ValidateInput } from '../BaseStream.ts';
import {
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
} from '../utils.ts';

const makeMockNodePort = (): Mocked<NodePort> & {
  messageHandler?: OnMessage | undefined;
} => {
  const port = {
    on: vi.fn((_event, listener) => {
      port.messageHandler = listener;
    }),
    off: vi.fn(() => {
      port.messageHandler = undefined;
    }),
    postMessage: vi.fn(),
    messageHandler: undefined as OnMessage | undefined,
  };
  return port;
};

describe('NodeWorkerDuplexStream', () => {
  const makeDuplexStream = async (
    port = makeMockNodePort(),
    validateInput?: ValidateInput<number>,
  ): Promise<NodeWorkerDuplexStream<number>> => {
    const duplexStreamP = NodeWorkerDuplexStream.make<number>(
      port,
      validateInput,
    );
    port.messageHandler?.(makeAck());
    return await duplexStreamP;
  };

  it('constructs a NodeWorkerDuplexStream', async () => {
    const port = makeMockNodePort();
    const duplexStream = await makeDuplexStream(port);

    expect(duplexStream).toBeInstanceOf(NodeWorkerDuplexStream);
    expect(duplexStream[Symbol.asyncIterator]()).toBe(duplexStream);
    expect(port.on).toHaveBeenCalledOnce();
  });

  it('reads messages from and writes messages to the port', async () => {
    const port = makeMockNodePort();
    const duplexStream = await makeDuplexStream(port);

    port.messageHandler?.(42);
    expect(await duplexStream.next()).toStrictEqual(makePendingResult(42));
    expect(await duplexStream.write(43)).toStrictEqual(
      makePendingResult(undefined),
    );
    expect(port.postMessage).toHaveBeenLastCalledWith(43);
  });

  it('calls validateInput with received input if specified', async () => {
    const validateInput = vi
      .fn()
      .mockReturnValue(true) as unknown as ValidateInput<number>;
    const port = makeMockNodePort();
    const duplexStream = await makeDuplexStream(port, validateInput);

    port.messageHandler?.(42);

    expect(await duplexStream.next()).toStrictEqual(makePendingResult(42));
    expect(validateInput).toHaveBeenCalledWith(42);
  });

  it('ends the reader when the writer ends', async () => {
    const port = makeMockNodePort();
    port.postMessage
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('foo');
      });
    const duplexStream = await makeDuplexStream(port);

    await expect(duplexStream.write(42)).rejects.toThrow(
      'NodeWorkerDuplexStream experienced a dispatch failure',
    );
    expect(await duplexStream.next()).toStrictEqual(makeDoneResult());
  });

  it('ends the writer and removes its listener when the reader ends', async () => {
    const port = makeMockNodePort();
    const duplexStream = await makeDuplexStream(port);
    const listener = port.messageHandler;

    const readP = duplexStream.next();
    port.messageHandler?.(makeStreamDoneSignal());
    await delay(10);
    expect(await duplexStream.write(42)).toStrictEqual(makeDoneResult());
    expect(await readP).toStrictEqual(makeDoneResult());
    expect(port.off).toHaveBeenCalledWith('message', listener);
  });
});
