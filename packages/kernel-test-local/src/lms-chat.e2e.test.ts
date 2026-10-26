import '@metamask/kernel-shims/endoify-node';

import { makeOpenV1NodejsService } from '@ocap/kernel-language-model-service';
import { fetchMock } from '@ocap/repo-tools/test-utils/fetch-mock';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { LMS_BASE_URL } from './constants.ts';
import { runLmsChatKernelTest } from './lms-chat.ts';

describe('lms-kernel (e2e)', () => {
  beforeAll(() => {
    fetchMock.disableMocks();
  });

  afterAll(() => {
    fetchMock.enableMocks();
  });

  // oxlint-disable-next-line vitest/expect-expect
  it(
    'sends a chat message through the kernel and receives a response',
    { timeout: 60_000 },
    async () => {
      const { chat } = makeOpenV1NodejsService({
        endowments: { fetch },
        baseUrl: LMS_BASE_URL,
      });
      await runLmsChatKernelTest(chat);
    },
  );
});
