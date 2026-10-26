import '@metamask/kernel-shims/endoify-node';

import { makeOpenV1NodejsService } from '@ocap/kernel-language-model-service';
import { makeMockOpenV1Fetch } from '@ocap/kernel-language-model-service/test-utils';
import { describe, it } from 'vitest';

import { runLmsChatKernelTest } from './lms-chat.ts';

describe.sequential('lms-kernel', () => {
  // oxlint-disable-next-line vitest/expect-expect
  it('sends a chat message through the kernel and receives a response', async () => {
    const { chat } = makeOpenV1NodejsService({
      endowments: { fetch: makeMockOpenV1Fetch(['Hello.']) },
      baseUrl: 'http://localhost:11434',
    });
    await runLmsChatKernelTest(chat);
  });
});
