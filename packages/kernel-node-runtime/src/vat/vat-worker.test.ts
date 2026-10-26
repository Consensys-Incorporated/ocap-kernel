import { makeCounter } from '@metamask/kernel-utils';
import type { VatId } from '@metamask/ocap-kernel';
import { makePromiseKitMock } from '@ocap/repo-tools/test-utils';
import { Worker as NodeWorker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

import { getTestWorkerFile } from '../../test/get-test-worker.ts';

const { makePromiseKit } = makePromiseKitMock();

describe('NodejsPlatformServices', () => {
  let testWorkerFile: string;
  const vatIdCounter = makeCounter();
  const getTestVatId = (): VatId => `v${vatIdCounter()}` as VatId;

  describe('hello-world', () => {
    testWorkerFile = getTestWorkerFile('hello-world');
    it('can start in a Node.js worker', async () => {
      const vatId = getTestVatId();
      const worker = new NodeWorker(testWorkerFile, {
        env: {
          NODE_VAT_ID: vatId,
        },
      });
      const { resolve, reject, promise } = makePromiseKit();
      worker.once('online', (error: Error) => {
        if (error) {
          reject(error);
        }
        resolve(vatId);
      });
      expect(await promise).toStrictEqual(vatId);
    });
  });
});
