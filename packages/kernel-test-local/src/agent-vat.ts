import type { Parser } from '@ocap/kernel-agents-repl';
import { launchAgentVat, reportFromLogs } from '@ocap/kernel-test/agent-vat';
import type {
  AgentVatParameters,
  AgentVatReport,
  ChatBackend,
  SampleBackend,
} from '@ocap/kernel-test/agent-vat';

import { makeLocalKernel } from './local-kernel.ts';

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
export const runAgentVat = async (args: {
  parameters: AgentVatParameters;
  chat?: ChatBackend;
  sample?: SampleBackend;
  parser: Parser;
}): Promise<AgentVatReport> => {
  const { kernel, entries } = await makeLocalKernel();
  try {
    await launchAgentVat(kernel, args);
    return reportFromLogs(entries);
  } finally {
    await kernel.stop();
  }
};
