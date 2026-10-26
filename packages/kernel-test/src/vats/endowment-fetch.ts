import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * Build a root object for a vat that uses the network endowment (`fetch`
 * plus `Request`, `Headers`, `Response` constructors).
 *
 * @param vatPowers - The powers of the vat.
 * @param vatPowers.logger - The logger for the vat.
 * @returns The root object.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export async function buildRootObject(vatPowers: TestPowers) {
  const tlog = unwrapTestLogger(vatPowers, 'endowment-user');

  tlog('buildRootObject');

  const root = makeDefaultExo('root', {
    bootstrap: () => {
      tlog('bootstrap');
    },
    hello: async (url: string) => {
      try {
        const response = await fetch(url);
        const text = await response.text();
        tlog(`response: ${text}`);
        // Verify hardened Request/Headers/Response constructors are
        // available on a successful path so the test can assert on them.
        tlog(
          `Request constructor: ${new Request(url) instanceof Request ? 'ok' : 'missing'}`,
        );
        tlog(
          `Headers constructor: ${new Headers({ 'x-test': '1' }) instanceof Headers ? 'ok' : 'missing'}`,
        );
        tlog(
          `Response constructor: ${new Response('body') instanceof Response ? 'ok' : 'missing'}`,
        );
        return text;
      } catch (error) {
        tlog(`error: ${String(error)}`);
        throw error;
      }
    },
    // The CWE-367 escape: an input that names the allowed host on the
    // caveat's read and a forbidden one on fetch's.
    fetchWithTwoFacedUrl: async (decoyUrl: string, targetUrl: string) => {
      let reads = 0;
      const twoFaced = {
        toString: () => {
          reads += 1;
          return reads === 1 ? decoyUrl : targetUrl;
        },
      };
      try {
        const response = await fetch(
          twoFaced as unknown as Parameters<typeof fetch>[0],
        );
        tlog(`fetched: ${response.headers.get('x-fetched-url')}`);
      } catch (error) {
        tlog(`error: ${String(error)}`);
      }
      tlog(`reads: ${reads}`);
    },
    fetchFollowingRedirect: async (url: string) => {
      try {
        const response = await fetch(url);
        tlog(`fetched: ${response.headers.get('x-fetched-url')}`);
        tlog(`redirect mode: ${response.headers.get('x-redirect-mode')}`);
        tlog(`redirected: ${String(response.redirected)}`);
        // Read through the hardened response wrapper the endowment returns,
        // which is not the plain `Response` the unit tests exercise.
        tlog(`body: ${await response.text()}`);
      } catch (error) {
        tlog(`error: ${String(error)}`);
      }
    },
    fetchWithIntegrity: async (url: string, integrity: string) => {
      try {
        const response = await fetch(url, { integrity });
        tlog(`body: ${await response.text()}`);
      } catch (error) {
        tlog(`error: ${String(error)}`);
      }
    },
    fetchWithSpoofedRequest: async (decoyUrl: string, targetUrl: string) => {
      /**
       * A `Request` whose `url` getter lies while its internal slot — the one
       * `fetch` reads — holds the forbidden host.
       */
      class SpoofedRequest extends Request {
        /** @returns The decoy URL, not the URL this request was built with. */
        // @ts-expect-error Deliberately shadows the `url` property with a getter.
        override get url(): string {
          return decoyUrl;
        }
      }
      try {
        const response = await fetch(new SpoofedRequest(targetUrl));
        tlog(`fetched: ${response.headers.get('x-fetched-url')}`);
      } catch (error) {
        tlog(`error: ${String(error)}`);
      }
    },
  });

  return root;
}
