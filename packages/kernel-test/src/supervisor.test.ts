import { delay } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import type { VatConfig, VatId } from '@metamask/ocap-kernel';
import { VatSupervisor, kser } from '@metamask/ocap-kernel';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

import { getBundleSpec, makeMockLogger } from './utils.ts';
import { TestDuplexStream } from '../../streams/test/stream-mocks.ts';

const makeVatSupervisor = async ({
  dispatch = () => undefined,
  vatPowers,
}: {
  dispatch?: (input: unknown) => void | Promise<void>;
  vatPowers?: Record<string, unknown>;
}) => {
  const kernelStream = await TestDuplexStream.make<
    JsonRpcMessage,
    JsonRpcMessage
  >(dispatch);

  return {
    supervisor: new VatSupervisor({
      id: 'test-id' as VatId,
      kernelStream,
      logger: makeMockLogger(),
      vatPowers,
      makePlatform: vi.fn().mockResolvedValue({}),

      fetchBlob: async (url: string): Promise<Response> => {
        if (!url.endsWith('.bundle')) {
          throw new Error(`Unexpected URL: ${url}`);
        }
        const bundleName = url.split('/').pop() ?? url;
        const bundlePath = join(import.meta.dirname, 'vats', bundleName);
        const bundleContent = await readFile(bundlePath, 'utf-8');
        return {
          ok: true,
          text: async () => bundleContent,
        } as Response;
      },
    }),
    stream: kernelStream,
  };
};

describe('VatSupervisor', () => {
  describe('initVat', () => {
    it('initializes vat with powers', async () => {
      let localValue: string | null = null;
      const vatPowers = {
        foo: async (value: string) => (localValue = value),
      };
      const { stream } = await makeVatSupervisor({
        vatPowers,
      });

      const vatConfig: VatConfig = {
        bundleSpec: getBundleSpec('powers-vat'),
        parameters: { bar: 'buzz' },
      };

      await stream.receiveInput({
        id: 'test-id-1',
        method: 'initVat',
        params: {
          vatConfig,
          state: [],
        },
        jsonrpc: '2.0',
      });

      await stream.receiveInput({
        id: 'test-id-2',
        method: 'deliver',
        params: [
          'message',
          'o+0',
          { methargs: kser(['fizz', []]), result: null },
        ],
        jsonrpc: '2.0',
      });
      await delay(100);

      expect(localValue).toBe('buzz');
    });
  });
});
