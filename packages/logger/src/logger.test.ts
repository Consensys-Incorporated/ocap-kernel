import type { DuplexStream } from '@metamask/streams';
import { delay } from '@ocap/repo-tools/test-utils';
import { describe, it, expect, vi } from 'vitest';

import { logLevels } from './constants.ts';
import { Logger } from './logger.ts';
import { lser } from './stream.ts';
import type { LogMessage } from './stream.ts';
import { makeConsoleTransport } from './transports.ts';

const consoleMethod = ['log', 'debug', 'info', 'warn', 'error'] as const;
const transports = [makeConsoleTransport({ tags: true })];

describe('Logger', () => {
  it.each([
    ['no arguments', undefined],
    ['an empty object', {}],
    ['a string tag', 'test'],
    [
      'an options bag',
      { tags: ['test'], transports: [makeConsoleTransport({ tags: true })] },
    ],
  ])('can be constructed with $description', (_description, options) => {
    const logger = new Logger(options);
    expect(logger).toBeInstanceOf(Logger);
  });

  it.each(consoleMethod)('has method %j', (method) => {
    const testLogger = new Logger({ tags: ['test'], transports });
    expect(testLogger).toHaveProperty(method);
    expect(testLogger[method]).toBeTypeOf('function');
  });

  it.each(consoleMethod)(
    'calls %j with the provided tags followed by a single argument',
    (method) => {
      const methodSpy = vi.spyOn(console, method);
      const tags = ['test'];
      const testLogger = new Logger({ tags, transports });
      testLogger[method]('foo');
      expect(methodSpy).toHaveBeenCalledWith(tags, 'foo');
    },
  );

  it.each(consoleMethod)(
    'calls %j with the provided tags followed by multiple arguments',
    (method) => {
      const methodSpy = vi.spyOn(console, method);
      const tags = ['test'];
      const testLogger = new Logger({ tags, transports });
      testLogger[method]('foo', { bar: 'bar' });
      expect(methodSpy).toHaveBeenCalledWith(tags, 'foo', { bar: 'bar' });
    },
  );

  it.each(consoleMethod)(
    'calls %j with the provided tags when given no argument',
    (method) => {
      const methodSpy = vi.spyOn(console, method);
      const tags = ['test'];
      const testLogger = new Logger({ tags, transports });
      testLogger[method]();
      expect(methodSpy).toHaveBeenCalledWith(tags);
    },
  );

  it('can be nested', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const vatLogger = new Logger({ tags: ['vat 0x01'] });
    const subLogger = vatLogger.subLogger({
      tags: ['(process)'],
      transports,
    });
    subLogger.log('foo');
    expect(consoleSpy).toHaveBeenCalledWith(['vat 0x01', '(process)'], 'foo');
  });

  it('omits tagline when no tags are provided', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const logger = new Logger();
    logger.log('foo');
    expect(consoleSpy).toHaveBeenCalledWith('foo');
  });

  it('passes objects directly in the data field', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const logger = new Logger({ tags: ['test'], transports });
    const message = 'foo';
    const data = { bar: 'bar' };
    logger.log(message, data);
    expect(consoleSpy).toHaveBeenCalledWith(['test'], message, data);
  });

  describe('subLogger', () => {
    it('creates a new logger with the merged options', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const logger = new Logger({ tags: ['test'], transports });
      const subLogger = logger.subLogger({ tags: ['sub'] });
      expect(subLogger).toBeInstanceOf(Logger);
      subLogger.log('foo');
      expect(consoleSpy).toHaveBeenCalledWith(['test', 'sub'], 'foo');
    });

    it('works with no options', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const logger = new Logger({ tags: ['test'], transports });
      const subLogger = logger.subLogger();
      expect(subLogger).toBeInstanceOf(Logger);
      subLogger.log('foo');
      expect(consoleSpy).toHaveBeenCalledWith(['test'], 'foo');
    });

    it('works with a string', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const logger = new Logger({ tags: ['test'], transports });
      const subLogger = logger.subLogger('sub');
      expect(subLogger).toBeInstanceOf(Logger);
      subLogger.log('foo');
      expect(consoleSpy).toHaveBeenCalledWith(['test', 'sub'], 'foo');
    });
  });

  describe('logging level limits output', () => {
    consoleMethod.forEach((level) => {
      it(`logging at level ${level}`, () => {
        const testLogger = new Logger({
          transports: [makeConsoleTransport({ level })],
        });
        consoleMethod.forEach((method) => {
          const consoleSpy = vi.spyOn(console, method);
          testLogger[method](`foo ${method}`);
          if (logLevels[level] <= logLevels[method]) {
            // oxlint-disable-next-line vitest/no-conditional-expect
            expect(consoleSpy).toHaveBeenCalledWith(`foo ${method}`);
          } else {
            // oxlint-disable-next-line vitest/no-conditional-expect
            expect(consoleSpy).not.toHaveBeenCalled();
          }
        });
      });
    });
  });

  describe('injectStream', () => {
    it('calls drain on the provided stream', () => {
      const logger = new Logger();
      const stream = { drain: vi.fn().mockResolvedValue(undefined) };
      logger.injectStream(stream as unknown as DuplexStream<LogMessage>);
      expect(stream.drain).toHaveBeenCalled();
    });

    it.each`
      description                             | logEntry
      ${'message and data'}                   | ${{ level: 'log', tags: ['test'], message: 'foo', data: ['bar'] }}
      ${'message but no data'}                | ${{ level: 'log', tags: ['test'], message: 'foo' }}
      ${'no message or data'}                 | ${{ level: 'log', tags: ['test'] }}
      ${'falsy message (0), no data'}         | ${{ level: 'log', tags: ['test'], message: 0 }}
      ${'falsy message (null), no data'}      | ${{ level: 'log', tags: ['test'], message: null }}
      ${'falsy message (false), no data'}     | ${{ level: 'log', tags: ['test'], message: false }}
      ${'falsy message (undefined), no data'} | ${{ level: 'log', tags: ['test'], message: undefined }}
    `(
      'delivers a logEntry to the logger transport: $description',
      ({ logEntry }) => {
        const testTransport = vi.fn();
        const logger = new Logger({ transports: [testTransport] });
        const stream = {
          drain: vi.fn(async (handler) =>
            handler({ params: ['logger', lser(logEntry)] }),
          ),
        } as unknown as DuplexStream<LogMessage>;
        logger.injectStream(stream);
        expect(testTransport).toHaveBeenCalledWith(
          expect.objectContaining(logEntry),
        );
      },
    );

    it('calls the provided onError if drain fails', async () => {
      const testError = new Error('test');
      const onError = vi.fn();
      const stream = {
        drain: vi.fn().mockRejectedValue(testError),
      } as unknown as DuplexStream<LogMessage>;
      const logger = new Logger();
      logger.injectStream(stream, onError);
      await delay(10);
      expect(onError).toHaveBeenCalledWith(testError);
    });
  });
});
