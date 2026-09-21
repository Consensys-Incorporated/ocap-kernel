import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * Build a root object for a vat that exercises global endowments.
 *
 * @param vatPowers - The powers of the vat.
 * @returns The root object.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function buildRootObject(vatPowers: TestPowers) {
  const tlog = unwrapTestLogger(vatPowers, 'endowment-globals');

  tlog('buildRootObject');

  const root = makeDefaultExo('root', {
    bootstrap: () => {
      tlog('bootstrap');
    },

    testTextCodec: () => {
      const encoder = new TextEncoder();
      const encoded = encoder.encode('hello');
      const decoder = new TextDecoder();
      const decoded = decoder.decode(encoded);
      tlog(`textCodec: ${decoded}`);
      return decoded;
    },

    testUrl: () => {
      const url = new URL('https://example.com/path?a=1');
      url.searchParams.set('b', '2');
      const params = new URLSearchParams('x=10&y=20');
      tlog(`url: ${url.pathname} params: ${params.get('x')}`);
      return url.toString();
    },

    testBase64: () => {
      const encoded = btoa('hello world');
      const decoded = atob(encoded);
      tlog(`base64: ${decoded}`);
      return decoded;
    },

    testAbort: () => {
      const controller = new AbortController();
      const { signal } = controller;
      const { aborted } = signal;
      controller.abort('test reason');
      tlog(`abort: before=${String(aborted)} after=${String(signal.aborted)}`);
      return signal.aborted;
    },

    testTimers: async () => {
      return new Promise((resolve) => {
        setTimeout(() => {
          tlog('timer: fired');
          resolve('fired');
        }, 10);
      });
    },

    testInterval: async () => {
      return new Promise((resolve) => {
        let tickCount = 0;
        const handle = setInterval(() => {
          tickCount += 1;
          if (tickCount >= 2) {
            clearInterval(handle);
            tlog(`interval: ticks=${tickCount}`);
            resolve(tickCount);
          }
        }, 10);
      });
    },

    testDate: () => {
      const now = Date.now();
      const isReal = !Number.isNaN(now) && now > 0;
      tlog(`date: isReal=${String(isReal)}`);
      return isReal;
    },

    testCrypto: () => {
      // A 16-byte buffer makes the all-zero coincidence vanishingly small
      // (2^-128); a 4-byte buffer has a ~1-in-4-billion false-negative rate.
      const buffer = new Uint8Array(16);
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- `crypto` here is the vat endowment, not the Node global; the rule's engines check does not apply inside a SES Compartment.
      crypto.getRandomValues(buffer);
      const hasRandomBytes = buffer.some((byte) => byte !== 0);
      tlog(`crypto: hasRandomBytes=${String(hasRandomBytes)}`);
      return hasRandomBytes;
    },

    testMath: () => {
      const value = Math.random();
      const inRange = value >= 0 && value < 1;
      tlog(`math: inRange=${String(inRange)}`);
      return inRange;
    },

    checkGlobal: (name: string) => {
      // In a SES compartment, globalThis points to the compartment's own
      // global object, so this correctly detects whether an endowment was
      // provided. Intrinsics (e.g. ArrayBuffer) are always present;
      // host/Web APIs (e.g. URL) are only present if endowed.
      const exists = name in globalThis;
      tlog(`checkGlobal: ${name}=${String(exists)}`);
      return exists;
    },
  });

  return root;
}
