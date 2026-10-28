import type {
  ChatParams,
  ChatResult,
  SampleParams,
  SampleResult,
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
import {
  PARSER_SERVICE_NAME,
  makeKernelParserService,
} from '@ocap/kernel-agents-repl';
import type { Parser } from '@ocap/kernel-agents-repl';
import {
  getAgentVatBundleSpec,
  reportFromLogs,
} from '@ocap/kernel-test/agent-vat';
import type {
  AgentVatParameters,
  AgentVatReport,
} from '@ocap/kernel-test/agent-vat';

import { filterTransports } from './utils.ts';

/**
 * Run the agent vat of `@ocap/kernel-test` on a fresh hardened kernel whose
 * language model service answers from the given backends, and report what the
 * agent did. The kernel is stopped afterwards.
 *
 * @param args - The arguments.
 * @param args.parameters - The vat's parameters.
 * @param args.chat - The chat backend, for the `chat` strategy.
 * @param args.sample - The sample backend, for the `json` and `repl` strategies.
 * @param args.parser - The parser offered to the `repl` strategy.
 * @returns The agent's report.
 */
export const runAgentVat = async ({
  parameters,
  chat,
  sample,
  parser,
}: {
  parameters: AgentVatParameters;
  chat: (params: ChatParams & { stream?: true & false }) => Promise<ChatResult>;
  sample?: (params: SampleParams) => Promise<SampleResult>;
  parser: Parser;
}): Promise<AgentVatReport> => {
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

  try {
    const languageModel = makeKernelLanguageModelService({
      chat,
      ...(sample && { sample }),
    });
    kernel.registerKernelServiceObject(
      languageModel.name,
      languageModel.service,
    );
    const parserService = makeKernelParserService(parser);
    kernel.registerKernelServiceObject(
      parserService.name,
      parserService.service,
    );

    await kernel.launchSubcluster({
      bootstrap: 'agent',
      services: [LANGUAGE_MODEL_SERVICE_NAME, PARSER_SERVICE_NAME],
      vats: {
        agent: { bundleSpec: getAgentVatBundleSpec(), parameters },
      },
    });
    await waitUntilQuiescent(100);
    return reportFromLogs(entries);
  } finally {
    await kernel.stop();
  }
};
