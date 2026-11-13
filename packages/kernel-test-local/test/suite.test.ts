/**
 * Pre-test verification suite that checks:
 *
 * - Configured LMS service is running and accessible
 * - Required model is available
 *
 * These tests run sequentially and must pass before the main test suite.
 */
import '@ocap/repo-tools/test-utils/mock-endoify';

import { makeOpenV1NodejsService } from '@metamask/kernel-language-model-service/open-v1/nodejs';
import { fetchMock } from '@ocap/repo-tools/test-utils/fetch-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LMS_BASE_URL, LMS_CHAT_MODEL } from '../src/constants.ts';

describe.sequential('test suite', () => {
  let service: ReturnType<typeof makeOpenV1NodejsService>;

  beforeAll(() => {
    fetchMock.disableMocks();
    service = makeOpenV1NodejsService({
      endowments: { fetch },
      baseUrl: LMS_BASE_URL,
    });
  });

  afterAll(() => {
    fetchMock.enableMocks();
  });

  it('connects to LMS service', async () => {
    expect(await service.listModels()).toBeDefined();
  });

  it(`can access ${LMS_CHAT_MODEL} model`, async () => {
    const models = await service.listModels();
    expect(models).toContain(LMS_CHAT_MODEL);
  });
});
