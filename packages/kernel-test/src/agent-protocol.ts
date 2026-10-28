/**
 * The contract between the agent vat and the tests that drive it: the vat's
 * parameters and the log lines it emits. Shared with the vat bundle, so this
 * module must stay free of host-only imports.
 */

export type AgentStrategy = 'json' | 'repl' | 'chat';

/**
 * The built-in capabilities a test may grant the agent, by name.
 */
export const AGENT_CAPABILITY_NAMES = [
  'count',
  'add',
  'multiply',
  'getMoonPhase',
  'search',
] as const;

export type AgentCapabilityName = (typeof AGENT_CAPABILITY_NAMES)[number];

export type AgentVatParameters = {
  strategy: AgentStrategy;
  model: string;
  intent: string;
  /** Capabilities granted to the agent; each invocation is logged. */
  capabilities?: AgentCapabilityName[];
  invocationBudget?: number;
  /**
   * A cap on tokens per sample. The kernel service cannot stream, so a sample
   * runs until the model stops on its own; the cap bounds that for models that
   * would otherwise continue past the statement the agent needed.
   */
  maxTokens?: number;
};

/** The tag on every log line the agent vat writes for the tests. */
export const AGENT_VAT_TAG = 'agent-vat';

const INVOKED = 'invoked: ';
const RESULT = 'result: ';
const ERROR = 'error: ';

export const formatInvocation = (name: string, args: unknown): string =>
  `${INVOKED}${name} ${JSON.stringify(args)}`;

export const formatResult = (result: unknown): string =>
  `${RESULT}${String(result)}`;

export const formatError = (error: unknown): string =>
  `${ERROR}${error instanceof Error ? error.message : String(error)}`;

/**
 * What the agent vat reported, recovered from its log lines.
 */
export type AgentVatReport = {
  /** The task's result, when the agent finished. */
  result?: string;
  /** The error message, when the agent failed. */
  error?: string;
  /** Each capability invocation as `<name> <JSON args>`, in order. */
  invocations: string[];
};

/**
 * Recover the agent vat's report from the lines it logged.
 *
 * @param lines - The messages of the vat's log entries, in order.
 * @returns The report.
 */
export const parseAgentLogs = (lines: string[]): AgentVatReport => {
  const report: AgentVatReport = { invocations: [] };
  for (const line of lines) {
    if (line.startsWith(INVOKED)) {
      report.invocations.push(line.slice(INVOKED.length));
    } else if (line.startsWith(RESULT)) {
      report.result = line.slice(RESULT.length);
    } else if (line.startsWith(ERROR)) {
      report.error = line.slice(ERROR.length);
    }
  }
  return report;
};
