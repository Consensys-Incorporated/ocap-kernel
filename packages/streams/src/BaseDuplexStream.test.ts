import { delay, stringify } from '@metamask/kernel-utils';
import { makeErrorMatcherFactory } from '@ocap/repo-tools/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { BaseDuplexStream, makeAck, makeSyn } from './BaseDuplexStream.ts';
import {
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
} from './utils.ts';
import { TestDuplexStream } from '../test/stream-mocks.ts';

const makeErrorMatcher = makeErrorMatcherFactory(expect);

describe('BaseDuplexStream', () => {
  it('constructs a BaseDuplexStream', () => {
    const stream = new TestDuplexStream(() => undefined);
    expect(stream).toBeInstanceOf(BaseDuplexStream);
    expect(stream[Symbol.asyncIterator]()).toBe(stream);
  });

  describe('synchronization', () => {
    it('writes a SYN message on construction', async () => {
      const onDispatch = vi.fn();
      const stream = new TestDuplexStream(onDispatch);
      stream.synchronize().catch(() => undefined);

      expect(onDispatch).toHaveBeenCalledOnce();
      expect(onDispatch).toHaveBeenCalledWith(makeSyn());
    });

    it('resolves the synchronization promise when receiving an ACK', async () => {
      const stream = new TestDuplexStream(() => undefined);

      await stream.receiveInput(makeAck());
      expect(await stream.completeSynchronization()).toBeUndefined();
    });

    it('writes an ACK message when receiving a SYN', async () => {
      const onDispatch = vi.fn();
      const stream = new TestDuplexStream(onDispatch);
      stream.synchronize().catch((error) => {
        throw error;
      });

      await stream.receiveInput(makeSyn());
      await delay(10);
      expect(onDispatch).toHaveBeenCalledTimes(2);
      expect(onDispatch).toHaveBeenNthCalledWith(2, makeAck());
    });

    it('handles calling drain before synchronization', async () => {
      const stream = new TestDuplexStream(() => undefined);
      const drainFn = vi.fn();

      const drainP = stream.drain(drainFn);
      await stream.completeSynchronization();
      await delay(10);
      expect(drainFn).not.toHaveBeenCalled();

      await stream.receiveInput(42);
      await delay(10);
      expect(drainFn).toHaveBeenCalledOnce();

      await stream.return();
      await drainP;
      expect(drainFn).toHaveBeenCalledTimes(1);
    });

    it('rejects the synchronization promise if receiving more than one SYN', async () => {
      const stream = new TestDuplexStream(() => undefined);
      stream.synchronize().catch(() => undefined);

      await stream.receiveInput(makeSyn());
      await stream.receiveInput(makeSyn());
      await expect(stream.next()).rejects.toThrow(
        'Received duplicate SYN message during synchronization',
      );
    });

    it('rejects the synchronization promise if receiving an unexpected message', async () => {
      const stream = new TestDuplexStream(() => undefined);
      stream.synchronize().catch(() => undefined);

      await stream.receiveInput(42);
      await expect(stream.next()).rejects.toThrow(
        `Received unexpected message during synchronization: ${stringify({
          done: false,
          value: 42,
        })}`,
      );
    });

    it('synchronization errors causes reads to always throw', async () => {
      const stream = new TestDuplexStream(() => undefined);
      stream.synchronize().catch(() => undefined);

      await stream.receiveInput(makeSyn());
      await stream.receiveInput(makeSyn());
      await expect(stream.next()).rejects.toThrow(
        'Received duplicate SYN message during synchronization',
      );
      await expect(stream.next()).rejects.toThrow(
        'Received duplicate SYN message during synchronization',
      );
    });

    it('synchronization errors causes writes to always throw', async () => {
      const stream = new TestDuplexStream(() => undefined);
      stream.synchronize().catch(() => undefined);

      await stream.receiveInput(makeSyn());
      await stream.receiveInput(makeSyn());
      await expect(stream.write(42)).rejects.toThrow(
        'Received duplicate SYN message during synchronization',
      );
      await expect(stream.write(42)).rejects.toThrow(
        'Received duplicate SYN message during synchronization',
      );
    });

    describe('idempotence', () => {
      it('repeated calls do not affect a pending synchronization', async () => {
        const onDispatch = vi.fn();
        const stream = new TestDuplexStream(onDispatch);

        // Begin synchronization
        stream.synchronize().catch(() => undefined);

        expect(onDispatch).toHaveBeenCalledOnce();
        expect(onDispatch).toHaveBeenCalledWith(makeSyn());

        // Repeat the call
        stream.synchronize().catch(() => undefined);
        await delay(10);

        expect(onDispatch).toHaveBeenCalledOnce();

        // Complete the synchronization, again repeating the call
        await stream.completeSynchronization();

        // In response to completing the synchronization, the stream
        // sends a single ACK message.
        expect(onDispatch).toHaveBeenCalledTimes(2);
        expect(onDispatch).toHaveBeenNthCalledWith(2, makeAck());
      });

      it('repeated calls after successful synchronization do nothing', async () => {
        const onDispatch = vi.fn();
        const stream = new TestDuplexStream(onDispatch);

        // Begin and complete synchronization
        await stream.completeSynchronization();

        expect(onDispatch).toHaveBeenCalledTimes(2);
        expect(onDispatch).toHaveBeenNthCalledWith(1, makeSyn());
        expect(onDispatch).toHaveBeenNthCalledWith(2, makeAck());

        // Repeat the call
        await stream.synchronize();

        expect(onDispatch).toHaveBeenCalledTimes(2);
      });

      it('repeated calls after failed synchronization re-throw the error', async () => {
        const stream = new TestDuplexStream(() => {
          throw new Error('foo');
        });

        const message = 'TestDuplexStream experienced a dispatch failure';
        await expect(stream.synchronize()).rejects.toThrow(message);
        await expect(stream.synchronize()).rejects.toThrow(message);
      });
    });

    describe('re-synchronization', () => {
      it('re-synchronizes if receiving a SYN message after completing synchronization', async () => {
        const stream = new TestDuplexStream(() => undefined);
        const syncP = stream.synchronize();
        await stream.receiveInput(makeAck());
        await syncP;

        const nextP = stream.next();
        await stream.receiveInput(makeSyn());
        await stream.receiveInput(makeAck());
        await stream.receiveInput(42);
        expect(await nextP).toStrictEqual(makePendingResult(42));
      });

      it('draining is unaffected by re-synchronization', async () => {
        const stream = new TestDuplexStream(() => undefined);
        const drainFn = vi.fn();

        const drainP = stream.drain(drainFn);
        const syncP = stream.synchronize();
        await stream.receiveInput(makeAck());
        await syncP;
        expect(drainFn).not.toHaveBeenCalled();

        await stream.receiveInput(42);
        await delay(10);
        expect(drainFn).toHaveBeenCalledOnce();

        await stream.receiveInput(makeSyn());
        await stream.receiveInput(makeAck());
        await stream.receiveInput(43);
        await delay(10);

        await stream.return();
        await drainP;
        expect(drainFn).toHaveBeenCalledTimes(2);
        expect(drainFn).toHaveBeenNthCalledWith(1, 42);
        expect(drainFn).toHaveBeenNthCalledWith(2, 43);
      });

      it('rejects the re-synchronization promise if receiving an unexpected message', async () => {
        const stream = new TestDuplexStream(() => undefined);
        const syncP = stream.synchronize();
        await stream.receiveInput(makeAck());
        await syncP;

        await stream.receiveInput(makeSyn());
        await stream.receiveInput(42);
        await expect(stream.next()).rejects.toThrow(
          `Received unexpected message during synchronization: ${stringify({
            done: false,
            value: 42,
          })}`,
        );
      });

      it('handles errors from the synchronization procedure', async () => {
        const onDispatch = vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('foo'));
        // Create synchronized duplex stream
        const stream = await TestDuplexStream.make(onDispatch);

        // Re-synchronize
        await stream.receiveInput(makeSyn());
        const nextP = stream.next();
        await stream.receiveInput(makeAck());
        await expect(nextP).rejects.toThrow(
          makeErrorMatcher(
            new Error('TestDuplexStream experienced a dispatch failure', {
              cause: new Error('foo'),
            }),
          ),
        );
      });
    });
  });

  it('reads from the reader', async () => {
    const stream = await TestDuplexStream.make(() => undefined);

    const message = 42;
    await stream.receiveInput(message);

    expect(await stream.next()).toStrictEqual(makePendingResult(message));
  });

  it('reads from the reader before synchronization', async () => {
    const stream = new TestDuplexStream(() => undefined);
    const nextP = stream.next();

    await stream.completeSynchronization();

    await stream.receiveInput(42);
    expect(await nextP).toStrictEqual(makePendingResult(42));
  });

  it('reads from the reader, with input validation', async () => {
    const stream = await TestDuplexStream.make(() => undefined, {
      validateInput: (value: unknown): value is number =>
        typeof value === 'number',
    });

    await stream.receiveInput(42);
    expect(await stream.next()).toStrictEqual(makePendingResult(42));
  });

  it('drains the reader in order', async () => {
    const stream = await TestDuplexStream.make(() => undefined);

    const messages = [1, 2, 3];
    await Promise.all(
      messages.map(async (message) => stream.receiveInput(message)),
    );
    await stream.return();

    let index = 0;
    const drainFn = vi.fn((value: number) => {
      expect(value).toStrictEqual(messages[index]);
      index += 1;
    });

    await stream.drain(drainFn);
    expect(drainFn).toHaveBeenCalledTimes(messages.length);
    expect(drainFn).toHaveBeenNthCalledWith(1, 1);
    expect(drainFn).toHaveBeenNthCalledWith(2, 2);
    expect(drainFn).toHaveBeenNthCalledWith(3, 3);
  });

  it('writes to the writer', async () => {
    const onDispatch = vi.fn();
    const stream = await TestDuplexStream.make(onDispatch);

    const message = 42;
    await stream.write(message);
    expect(onDispatch).toHaveBeenCalledWith(message);
  });

  it('writes to the writer before synchronization', async () => {
    const onDispatch = vi.fn();
    const stream = new TestDuplexStream(onDispatch);

    const message = 42;
    stream.write(message).catch(() => undefined);

    expect(onDispatch).not.toHaveBeenCalled();

    await stream.completeSynchronization();

    expect(onDispatch).toHaveBeenCalledWith(message);
  });

  it('pipes to another duplex stream', async () => {
    const stream = await TestDuplexStream.make(() => undefined);
    const onDispatch = vi.fn();
    const sink = await TestDuplexStream.make(onDispatch);

    const pipeP = stream.pipe(sink);
    await stream.receiveInput(42);
    await stream.receiveInput(43);
    await stream.return();
    await pipeP;

    expect(onDispatch).toHaveBeenCalledWith(42);
    expect(onDispatch).toHaveBeenLastCalledWith(43);

    await sink.return();
  });

  it.each([
    ['returning', async (stream: TestDuplexStream) => stream.return()],
    [
      'throwing',
      async (stream: TestDuplexStream) => stream.throw(new Error('foo')),
    ],
    [
      'the remote ending',
      async (stream: TestDuplexStream) =>
        stream.receiveInput(makeStreamDoneSignal()),
    ],
  ])('calls onEnd once after %s', async (_, endStream) => {
    const onEnd = vi.fn();
    const stream = await TestDuplexStream.make(() => undefined, { onEnd });

    await endStream(stream);
    await stream.return();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(await stream.next()).toStrictEqual(makeDoneResult());
  });

  it('ends and calls onEnd if a write fails', async () => {
    const onDispatch = vi.fn();
    const onEnd = vi.fn();
    const stream = await TestDuplexStream.make(onDispatch, { onEnd });
    onDispatch.mockImplementation(() => {
      throw new Error('foo');
    });

    await expect(stream.write(42)).rejects.toThrow(
      'TestDuplexStream experienced a dispatch failure',
    );
    expect(onEnd).toHaveBeenCalledOnce();
    expect(await stream.next()).toStrictEqual(makeDoneResult());
  });

  it('dispatches the done signal before calling onEnd', async () => {
    const calls: string[] = [];
    const stream = await TestDuplexStream.make(
      (value) => {
        calls.push(stringify(value));
      },
      { onEnd: () => calls.push('onEnd') },
    );
    calls.length = 0;

    await stream.receiveInput(makeStreamDoneSignal());
    expect(calls).toStrictEqual([stringify(makeStreamDoneSignal()), 'onEnd']);
  });

  describe('end', () => {
    it('calls return() if no error is provided', async () => {
      const stream = await TestDuplexStream.make(() => undefined);
      const nextP = stream.next();
      expect(await stream.end()).toStrictEqual(makeDoneResult());
      expect(await nextP).toStrictEqual(makeDoneResult());
    });

    it('calls throw() if an error is provided', async () => {
      const stream = await TestDuplexStream.make(() => undefined);
      const nextP = stream.next();
      expect(await stream.end(new Error('foo'))).toStrictEqual(
        makeDoneResult(),
      );
      await expect(nextP).rejects.toThrow('foo');
    });
  });
});
