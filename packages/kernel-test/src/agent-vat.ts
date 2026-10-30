/**
 * Host-side access to the agent vat for tests in this package and in
 * `@ocap/kernel-test-local`: where its bundle is, how to launch it, how to
 * script a model for it, and how to read what it logged.
 */
import {
  LANGUAGE_MODEL_SERVICE_NAME,
  makeKernelLanguageModelService,
} from '@metamask/kernel-language-model-service';
import type { KernelLanguageModelServiceOptions } from '@metamask/kernel-language-model-service';
import { makeMockSample } from '@metamask/kernel-language-model-service/test-utils';
import { ifDefined, waitUntilQuiescent } from '@metamask/kernel-utils';
import type { LogEntry } from '@metamask/logger';
import { kunser } from '@metamask/ocap-kernel';
import type { Kernel } from '@metamask/ocap-kernel';
import {
  PARSER_SERVICE_NAME,
  makeKernelParserService,
} from '@ocap/kernel-agents-repl';
import type { Parser } from '@ocap/kernel-agents-repl';

import { AGENT_VAT_TAG, parseAgentLogs } from './agent-protocol.ts';
import type { AgentVatParameters, AgentVatReport } from './agent-protocol.ts';
import { extractTestLogs } from './test-logs.ts';

export type {
  AgentCapabilityName,
  AgentStrategy,
  AgentVatParameters,
  AgentVatReport,
} from './agent-protocol.ts';
export { AGENT_CAPABILITY_NAMES, AGENT_VAT_TAG } from './agent-protocol.ts';

export type ChatBackend = KernelLanguageModelServiceOptions['chat'];
export type SampleBackend = NonNullable<
  KernelLanguageModelServiceOptions['sample']
>;

/**
 * @returns The bundle spec of the agent vat, built by this package's `build`.
 */
export const getAgentVatBundleSpec = (): string =>
  new URL('./vats/agent-vat.bundle', import.meta.url).toString();

/**
 * Launch the agent vat on a kernel, offering it a language model service that
 * answers from the given backends and a parser service, and wait for the
 * agent to finish.
 *
 * @param kernel - The kernel.
 * @param args - The arguments.
 * @param args.parameters - The vat's parameters.
 * @param args.chat - The chat backend, for the `chat` strategy.
 * @param args.sample - The sample backend, for the `json` and `repl` strategies.
 * Without one, the service rejects a sample.
 * @param args.parser - The parser offered to the `repl` strategy.
 * @returns The bootstrap result: the agent's result, or `undefined` if it
 * failed.
 */
export const launchAgentVat = async (
  kernel: Kernel,
  {
    parameters,
    chat = async () => {
      throw new Error('chat not mocked');
    },
    sample,
    parser,
  }: {
    parameters: AgentVatParameters;
    chat?: ChatBackend;
    sample?: SampleBackend;
    parser: Parser;
  },
): Promise<unknown> => {
  const languageModel = makeKernelLanguageModelService({
    chat,
    ...ifDefined({ sample }),
  });
  kernel.registerKernelServiceObject(languageModel.name, languageModel.service);
  const parserService = makeKernelParserService(parser);
  kernel.registerKernelServiceObject(parserService.name, parserService.service);

  const { bootstrapResult } = await kernel.launchSubcluster({
    bootstrap: 'agent',
    services: [LANGUAGE_MODEL_SERVICE_NAME, PARSER_SERVICE_NAME],
    vats: {
      agent: { bundleSpec: getAgentVatBundleSpec(), parameters },
    },
  });
  await waitUntilQuiescent(100);
  return bootstrapResult && kunser(bootstrapResult);
};

/**
 * Script the JSON strategy's model. Its prompt ends with
 * `{"messageType":"assistant","`, which the reader prepends to the sample, so
 * each answer starts mid-object.
 *
 * @param messages - The assistant messages to answer with, in order.
 * @returns The sample backend.
 */
export const makeJsonSample = (messages: string[]): SampleBackend =>
  makeMockSample(messages.map((message) => `invoke":${message}}`));

/**
 * Script the REPL strategy's model. Its prompt ends with an opening token and
 * a `>` prompt, and its reader collects the sample up to the matching closing
 * token, which is random per task. This backend recovers the token from each
 * prompt.
 *
 * @param statements - The statements to answer with, in order.
 * @returns The sample backend.
 */
export const makeReplSample = (statements: string[]): SampleBackend => {
  let index = 0;
  return async ({ prompt }) => {
    const match = /〚(?<token>[^〛]+)〛>$/u.exec(prompt);
    const token = match?.groups?.token;
    if (!token) {
      throw new Error(`No REPL token at the end of the prompt: ${prompt}`);
    }
    const statement = statements[index] ?? '';
    index += 1;
    return harden({ text: ` ${statement}〚/${token}〛` });
  };
};

/**
 * Recover the agent vat's report from a kernel's captured log entries.
 *
 * @param entries - The entries, e.g. from a `makeArrayTransport`.
 * @returns The report.
 */
export const reportFromLogs = (entries: LogEntry[]): AgentVatReport =>
  parseAgentLogs(extractTestLogs(entries, AGENT_VAT_TAG));
