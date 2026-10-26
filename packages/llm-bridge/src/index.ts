/**
 * `ocap-llm-bridge` entry point.
 *
 * Reads the Unix-socket path from the first positional argument or the
 * `LLM_BRIDGE_SOCKET` env var, plus gateway URL, bearer token, and
 * agent model from `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` /
 * `OPENCLAW_AGENT_MODEL`, then runs the bridge until the kernel-side
 * socket closes (or the process is signalled).
 */

import { makeConversation } from './conversation.ts';
import { makeOpenClawClient } from './openclaw-client.ts';
import { runBridge } from './run-bridge.ts';

export { makeConversation } from './conversation.ts';
export { makeOpenClawClient } from './openclaw-client.ts';
export { runBridge } from './run-bridge.ts';
export type {
  ChatMessage,
  ChatRole,
  OpenClawClient,
  OpenClawClientConfig,
} from './openclaw-client.ts';
export type { Conversation } from './conversation.ts';
export type {
  IngestRequest,
  MatchEntry,
  MatchesReply,
  MethodDigest,
  QueryRequest,
  Reply,
  Request,
  ServiceDigest,
} from './protocol.ts';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18789';
const DEFAULT_AGENT_MODEL = 'openclaw';

if (import.meta.url === `file://${process.argv[1]}`) {
  // Treated as a script invocation.
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    // oxlint-disable-next-line no-console
    console.error(`[llm-bridge] fatal: ${message}`);
    process.exitCode = 1;
  });
}

/**
 * Main entry point used when the package is invoked as a CLI.
 */
async function main(): Promise<void> {
  const socketPath =
    // oxlint-disable-next-line node/no-process-env
    process.env.LLM_BRIDGE_SOCKET ?? process.argv[2];
  if (!socketPath) {
    throw new Error(
      'expected the kernel IO socket path as the first positional argument or in $LLM_BRIDGE_SOCKET',
    );
  }
  // oxlint-disable-next-line node/no-process-env
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error(
      'expected the openclaw gateway bearer token in $OPENCLAW_GATEWAY_TOKEN',
    );
  }
  const baseUrl =
    // oxlint-disable-next-line node/no-process-env
    process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
  const model =
    // oxlint-disable-next-line node/no-process-env
    process.env.OPENCLAW_AGENT_MODEL ?? DEFAULT_AGENT_MODEL;

  const log = (message: string): void => {
    // oxlint-disable-next-line no-console
    console.error(`[llm-bridge] ${message}`);
  };
  const client = makeOpenClawClient({ baseUrl, token, model, log });
  const conversation = makeConversation(client);

  log(`starting; gateway=${baseUrl} model=${model} socket=${socketPath}`);

  await runBridge({ socketPath, conversation, log });
}
