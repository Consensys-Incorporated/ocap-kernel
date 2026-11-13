import type {
  ChatParams,
  ChatResult,
} from '@metamask/kernel-language-model-service';
import {
  LANGUAGE_MODEL_SERVICE_NAME,
  makeKernelLanguageModelService,
} from '@metamask/kernel-language-model-service';
import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import {
  Logger,
  makeArrayTransport,
  makeConsoleTransport,
} from '@metamask/logger';
import type { LogEntry } from '@metamask/logger';
import { Kernel } from '@metamask/ocap-kernel';
import { expect } from 'vitest';

import { LMS_CHAT_MODEL } from './constants.ts';
import { filterTransports } from './utils.ts';

const getBundleSpec = (name: string): string =>
  new URL(`./vats/${name}.bundle`, import.meta.url).toString();

export const runLmsChatKernelTest = async (
  chat: (params: ChatParams & { stream?: true & false }) => Promise<ChatResult>,
): Promise<void> => {
  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: ':memory:',
  });

  const entries: LogEntry[] = [];
  const logger = new Logger({
    transports: [
      filterTransports(makeConsoleTransport(), makeArrayTransport(entries)),
    ],
  });

  const platformServices = new NodejsPlatformServices({
    logger: logger.subLogger({ tags: ['vat-worker-manager'] }),
  });

  const kernel = await Kernel.make(platformServices, kernelDatabase, {
    resetStorage: true,
    logger,
  });

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
