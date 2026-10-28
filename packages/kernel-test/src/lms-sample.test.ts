import {
  LANGUAGE_MODEL_SERVICE_NAME,
  makeKernelLanguageModelService,
} from '@metamask/kernel-language-model-service';
import { makeMockSample } from '@metamask/kernel-language-model-service/test-utils';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { LogEntry } from '@metamask/logger';
import { describe, expect, it, vi } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runTestVats,
} from './utils.ts';

describe('lms-sample vat', () => {
  it('receives sample response via makeSampleClient', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { logger, entries } = makeTestLogger();
    const kernel = await makeKernel(kernelDatabase, true, logger);

    const chat = vi.fn();
    const { name, service } = makeKernelLanguageModelService({
      chat,
      sample: makeMockSample(['The sky is blue.']),
    });
    kernel.registerKernelServiceObject(name, service);

    await runTestVats(kernel, {
      bootstrap: 'main',
      services: [LANGUAGE_MODEL_SERVICE_NAME],
      vats: {
        main: {
          bundleSpec: getBundleSpec('lms-sample-vat'),
          parameters: { prompt: 'What color is the sky?' },
        },
      },
    });
    await waitUntilQuiescent(100);

    expect(
      entries.some(
        (entry: LogEntry) =>
          entry.message?.includes('response: The sky is blue.') ?? false,
      ),
    ).toBe(true);
  });
});
