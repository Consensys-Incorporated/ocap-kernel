import {
  LANGUAGE_MODEL_SERVICE_NAME,
  makeKernelLanguageModelService,
} from '@metamask/kernel-language-model-service';
import type { KernelLanguageModelServiceOptions } from '@metamask/kernel-language-model-service';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { expect } from 'vitest';

import { LMS_CHAT_MODEL } from './constants.ts';
import { makeLocalKernel } from './local-kernel.ts';

const getBundleSpec = (name: string): string =>
  new URL(`./vats/${name}.bundle`, import.meta.url).toString();

export const runLmsChatKernelTest = async (
  chat: KernelLanguageModelServiceOptions['chat'],
): Promise<void> => {
  const { kernel, entries } = await makeLocalKernel();

  const { name, service } = makeKernelLanguageModelService({ chat });
  kernel.registerKernelServiceObject(name, service);

  await kernel.launchSubcluster({
    bootstrap: 'main',
    services: [LANGUAGE_MODEL_SERVICE_NAME],
    vats: {
      main: {
        bundleSpec: getBundleSpec('lms-chat-vat'),
        parameters: { model: LMS_CHAT_MODEL },
      },
    },
  });
  await waitUntilQuiescent(100);

  const responseEntry = entries.find((entry) =>
    entry.message?.startsWith('lms-chat response:'),
  );
  expect(responseEntry).toBeDefined();
  expect(responseEntry?.message?.length).toBeGreaterThan(
    'lms-chat response: '.length,
  );
  expect(responseEntry?.message).toMatch(/^lms-chat response: [hH]ello[.!]?$/u);
};
