import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import {
  LANGUAGE_MODEL_SERVICE_NAME,
  makeKernelLanguageModelService,
  makeOpenV1NodejsService,
} from '@ocap/kernel-language-model-service';
import { makeMockOpenV1Fetch } from '@ocap/kernel-language-model-service/test-utils';
import { describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runTestVats,
} from './utils.ts';

describe('lms-chat vat', () => {
  it('receives chat response via makeChatClient', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { logger, entries } = makeTestLogger();
    const kernel = await makeKernel(kernelDatabase, true, logger);

    const { chat } = makeOpenV1NodejsService({
      endowments: { fetch: makeMockOpenV1Fetch(['My name is Alice.']) },
      baseUrl: 'http://localhost:11434',
    });
    const { name, service } = makeKernelLanguageModelService(chat);
    kernel.registerKernelServiceObject(name, service);

    await runTestVats(kernel, {
      bootstrap: 'main',
      services: [LANGUAGE_MODEL_SERVICE_NAME],
      vats: {
        main: {
          bundleSpec: getBundleSpec('lms-chat-vat'),
          parameters: { name: 'Alice' },
        },
      },
    });
    await waitUntilQuiescent(100);

    expect(
      entries.some((entry) =>
        entry.message?.includes('response: My name is Alice.'),
      ),
    ).toBe(true);
  });
});
