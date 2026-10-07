import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  isConsoleForwardMessage,
  isIframeWindow,
  setupConsoleForwarding,
  handleConsoleForwardMessage,
} from './console-forwarding.ts';
import type { ConsoleForwardMessage } from './console-forwarding.ts';

// Mock harden to do nothing since we're not in SES
vi.stubGlobal(
  'harden',
  vi.fn((obj: unknown) => obj),
);

describe('console-forwarding', () => {
  describe('isConsoleForwardMessage', () => {
    it('returns true for valid console-forward message', () => {
      const message: ConsoleForwardMessage = {
        jsonrpc: '2.0',
        method: 'console-forward',
        params: {
          source: 'offscreen',
          method: 'log',
          args: ['test'],
        },
      };
      expect(isConsoleForwardMessage(message)).toBe(true);
    });

    it.each([
      { name: 'null', value: null },
      { name: 'undefined', value: undefined },
      { name: 'string', value: 'test' },
      { name: 'number', value: 123 },
      { name: 'array', value: [] },
      { name: 'object without method', value: { jsonrpc: '2.0' } },
      { name: 'object with different method', value: { method: 'other' } },
      {
        name: 'missing jsonrpc',
        value: {
          method: 'console-forward',
          params: { source: 'test', method: 'log', args: [] },
        },
      },
      {
        name: 'missing params',
        value: { jsonrpc: '2.0', method: 'console-forward' },
      },
      {
        name: 'null params',
        value: { jsonrpc: '2.0', method: 'console-forward', params: null },
      },
      {
        name: 'missing source in params',
        value: {
          jsonrpc: '2.0',
          method: 'console-forward',
          params: { method: 'log', args: [] },
        },
      },
      {
        name: 'missing method in params',
        value: {
          jsonrpc: '2.0',
          method: 'console-forward',
          params: { source: 'test', args: [] },
        },
      },
      {
        name: 'missing args in params',
        value: {
          jsonrpc: '2.0',
          method: 'console-forward',
          params: { source: 'test', method: 'log' },
        },
      },
      {
        name: 'non-array args',
        value: {
          jsonrpc: '2.0',
          method: 'console-forward',
          params: { source: 'test', method: 'log', args: 'not-array' },
        },
      },
      {
        name: 'invalid console method',
        value: {
          jsonrpc: '2.0',
          method: 'console-forward',
          params: { source: 'test', method: 'invalid', args: [] },
        },
      },
    ])('returns false for $name', ({ value }) => {
      expect(isConsoleForwardMessage(value)).toBe(false);
    });
  });

  describe('isIframeWindow', () => {
    const iframeWindow = {} as Window;

    beforeEach(() => {
      vi.stubGlobal('document', {
        querySelectorAll: vi.fn(() => [
          { contentWindow: null },
          { contentWindow: iframeWindow },
        ]),
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns true for the window of an iframe in the document', () => {
      expect(isIframeWindow(iframeWindow)).toBe(true);
    });

    it.each([
      { name: 'null', source: null },
      { name: 'an unknown window', source: {} as Window },
    ])('returns false for $name', ({ source }) => {
      expect(isIframeWindow(source)).toBe(false);
    });
  });

  describe('setupConsoleForwarding', () => {
    let originalConsole: typeof console;
    let mockOnMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalConsole = { ...console };
      mockOnMessage = vi.fn();
    });

    afterEach(() => {
      // Restore original console methods
      Object.assign(console, originalConsole);
    });

    it('wraps all console methods', () => {
      setupConsoleForwarding({
        source: 'test-source',
        onMessage: mockOnMessage,
      });

      const methods = ['log', 'debug', 'info', 'warn', 'error'] as const;
      for (const method of methods) {
        expect(console[method]).not.toBe(originalConsole[method]);
      }
    });

    it.each(['log', 'debug', 'info', 'warn', 'error'] as const)(
      'forwards %s method via onMessage callback',
      (method) => {
        setupConsoleForwarding({
          source: 'test-source',
          onMessage: mockOnMessage,
        });

        console[method]('test message', 123);

        expect(mockOnMessage).toHaveBeenCalledWith({
          jsonrpc: '2.0',
          method: 'console-forward',
          params: {
            source: 'test-source',
            method,
            args: ['"test message"', '123'],
          },
        });
      },
    );

    it('calls original console method', () => {
      // Spy on console.log BEFORE setupConsoleForwarding captures it
      const originalLog = vi.spyOn(console, 'log');
      setupConsoleForwarding({
        source: 'test-source',
        onMessage: mockOnMessage,
      });

      console.log('test');

      expect(originalLog).toHaveBeenCalledWith('test');
      originalLog.mockRestore();
    });

    it('sends messages that pass isConsoleForwardMessage check', () => {
      setupConsoleForwarding({
        source: 'test-source',
        onMessage: mockOnMessage,
      });

      console.log('test');

      const sentMessage = mockOnMessage.mock.calls[0][0];
      expect(isConsoleForwardMessage(sentMessage)).toBe(true);
    });

    it.each([
      { name: 'BigInt', value: BigInt(123), expected: '123' },
      { name: 'Symbol', value: Symbol('test'), expected: 'Symbol(test)' },
    ])('handles $name values without throwing', ({ value, expected }) => {
      setupConsoleForwarding({
        source: 'test-source',
        onMessage: mockOnMessage,
      });

      expect(() => console.log(value)).not.toThrow();
      expect(mockOnMessage).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'console-forward',
        params: {
          source: 'test-source',
          method: 'log',
          args: [expected],
        },
      });
    });

    it('handles Function values without throwing', () => {
      setupConsoleForwarding({
        source: 'test-source',
        onMessage: mockOnMessage,
      });

      const testFunction = () => 'test';
      expect(() => console.log(testFunction)).not.toThrow();
      expect(mockOnMessage).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'console-forward',
        params: {
          source: 'test-source',
          method: 'log',
          args: ['() => "test"'],
        },
      });
    });
  });

  describe('handleConsoleForwardMessage', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      consoleSpy?.mockRestore();
    });

    it.each(['log', 'debug', 'info', 'warn', 'error'] as const)(
      'calls console.%s with source prefix and args',
      (method) => {
        consoleSpy = vi
          .spyOn(console, method)
          .mockImplementation(() => undefined);

        const message: ConsoleForwardMessage = {
          jsonrpc: '2.0',
          method: 'console-forward',
          params: {
            source: 'offscreen',
            method,
            args: ['arg1', 'arg2'],
          },
        };

        handleConsoleForwardMessage(message);

        expect(consoleSpy).toHaveBeenCalledWith('[offscreen]', 'arg1', 'arg2');
      },
    );

    it('uses source from message for prefix', () => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      const message: ConsoleForwardMessage = {
        jsonrpc: '2.0',
        method: 'console-forward',
        params: {
          source: 'kernel-worker',
          method: 'log',
          args: ['test'],
        },
      };

      handleConsoleForwardMessage(message);

      expect(consoleSpy).toHaveBeenCalledWith('[kernel-worker]', 'test');
    });

    it('handles vat source prefixes', () => {
      consoleSpy = vi
        .spyOn(console, 'info')
        .mockImplementation(() => undefined);

      const message: ConsoleForwardMessage = {
        jsonrpc: '2.0',
        method: 'console-forward',
        params: {
          source: 'vat-v1',
          method: 'info',
          args: ['vat message'],
        },
      };

      handleConsoleForwardMessage(message);

      expect(consoleSpy).toHaveBeenCalledWith('[vat-v1]', 'vat message');
    });
  });
});
