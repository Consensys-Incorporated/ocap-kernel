/**
 * Host-side access to the agent vat for tests in this package and in
 * `@ocap/kernel-test-local`: where its bundle is, and how to read what it
 * logged.
 */
import type { LogEntry } from '@metamask/logger';

import { AGENT_VAT_TAG, parseAgentLogs } from './agent-protocol.ts';
import type { AgentVatReport } from './agent-protocol.ts';

export type {
  AgentCapabilityName,
  AgentStrategy,
  AgentVatParameters,
  AgentVatReport,
} from './agent-protocol.ts';
export { AGENT_CAPABILITY_NAMES, AGENT_VAT_TAG } from './agent-protocol.ts';

/**
 * @returns The bundle spec of the agent vat, built by this package's `build`.
 */
export const getAgentVatBundleSpec = (): string =>
  new URL('./vats/agent-vat.bundle', import.meta.url).toString();

/**
 * Recover the agent vat's report from a kernel's captured log entries.
 *
 * @param entries - The entries, e.g. from a `makeArrayTransport`.
 * @returns The report.
 */
export const reportFromLogs = (entries: LogEntry[]): AgentVatReport =>
  parseAgentLogs(
    entries
      .filter(({ tags }) => tags.includes('test') && tags.includes(AGENT_VAT_TAG))
      .map(({ message }) => message ?? ''),
  );
