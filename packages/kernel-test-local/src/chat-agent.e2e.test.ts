import '@ocap/repo-tools/test-utils/mock-endoify';

import { makeOpenV1NodejsService } from '@metamask/kernel-language-model-service';
import { add } from '@ocap/kernel-agents/capabilities/math';
import { makeChatAgent } from '@ocap/kernel-agents/chat';
import type { BoundChat } from '@ocap/kernel-agents/chat';
import { fetchMock } from '@ocap/repo-tools/test-utils/fetch-mock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LMS_BASE_URL, LMS_CHAT_MODEL } from './constants.ts';

describe.sequential('makeChatAgent tool calling (e2e)', () => {
  beforeAll(() => {
    fetchMock.disableMocks();
  });

  afterAll(() => {
    fetchMock.enableMocks();
  });

  it(
    'invokes the add tool and returns the computed sum',
    { timeout: 60_000 },
    async () => {
      const service = makeOpenV1NodejsService({
        endowments: { fetch },
        baseUrl: LMS_BASE_URL,
      });

      const chat: BoundChat = async ({ messages, tools }) =>
        service.chat({
          model: LMS_CHAT_MODEL,
          messages,
          ...(tools && { tools }),
        });

      const addSpy = vi.spyOn(add, 'func');
      const agent = makeChatAgent({ chat, capabilities: { add } });

      const result = await agent.task(
        'What is 123 plus 456? Use the add tool to compute it.',
      );

      expect(addSpy).toHaveBeenCalled();
      expect(typeof result).toBe('string');
      expect(result as string).toContain('579');
    },
  );
});
