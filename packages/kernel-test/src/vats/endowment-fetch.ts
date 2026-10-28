import { makeFetch } from '@metamask/kernel-platforms';
import type { HttpCapability } from '@metamask/kernel-platforms';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

declare const http: HttpCapability;

/**
 * Build a root object for a vat that reaches the network through its `http`
 * endowment, spelled as `fetch` by `makeFetch`.
 *
 * @param vatPowers - The powers of the vat.
 * @param vatPowers.logger - The logger for the vat.
 * @returns The root object.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export async function buildRootObject(vatPowers: TestPowers) {
  const tlog = unwrapTestLogger(vatPowers, 'endowment-user');
  const vatFetch = makeFetch(http);

  tlog('buildRootObject');

  /**
   * Make an input that names `decoyUrl` when first read and `targetUrl` after.
   *
   * @param decoyUrl - The URL the first read gives.
   * @param targetUrl - The URL every later read gives.
   * @param asUrl - Whether to make it a `URL`, rather than a plain object.
   * @returns The input, and a count of its reads.
   */
  const makeTwoFaced = (
    decoyUrl: string,
    targetUrl: string,
    asUrl: boolean,
  ): { input: string | URL; reads: { count: number } } => {
    const reads = { count: 0 };
    const readOnce = (): string => {
      reads.count += 1;
      return reads.count === 1 ? decoyUrl : targetUrl;
    };
    /** A `URL` whose string form changes after the first read. */
    class TwoFacedUrl extends URL {
      /** @returns The decoy on the first read, the target after. */
      override toString(): string {
        return readOnce();
      }
    }
    const input = asUrl ? new TwoFacedUrl(decoyUrl) : { toString: readOnce };
    return { input: input as string | URL, reads };
  };

  const root = makeDefaultExo('root', {
    bootstrap: () => {
      tlog('bootstrap');
    },
    hello: async (url: string) => {
      try {
        const response = await vatFetch(url);
        const text = await response.text();
        tlog(`response: ${text}`);
        return text;
      } catch (error) {
        tlog(`error: ${String(error)}`);
        throw error;
      }
    },
    fetchWithTwoFacedUrl: async (
      decoyUrl: string,
      targetUrl: string,
      asUrl: boolean,
    ) => {
      const { input, reads } = makeTwoFaced(decoyUrl, targetUrl, asUrl);
      try {
        const response = await vatFetch(input);
        tlog(`fetched: ${response.headers.get('x-fetched-url')}`);
      } catch (error) {
        tlog(`error: ${String(error)}`);
      }
      tlog(`reads: ${reads.count}`);
    },
    fetchFollowingRedirect: async (url: string) => {
      try {
        const response = await vatFetch(url);
        tlog(`fetched: ${response.headers.get('x-fetched-url')}`);
        tlog(`redirect mode: ${response.headers.get('x-redirect-mode')}`);
        tlog(`redirected: ${String(response.redirected)}`);
        tlog(`body: ${await response.text()}`);
      } catch (error) {
        tlog(`error: ${String(error)}`);
      }
    },
    fetchWithIntegrity: async (url: string, integrity: string) => {
      try {
        const response = await vatFetch(url, { integrity });
        tlog(`body: ${await response.text()}`);
      } catch (error) {
        tlog(`error: ${String(error)}`);
      }
    },
  });

  return root;
}
