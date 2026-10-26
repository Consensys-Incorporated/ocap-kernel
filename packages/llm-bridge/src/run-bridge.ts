/**
 * Connect to a Unix socket exposing a kernel `IOChannel`, read
 * line-delimited JSON requests, dispatch each to a {@link Conversation},
 * and write the JSON reply back. Loops until the socket closes or an
 * unrecoverable error occurs.
 *
 * The matching IOChannel implementation in
 * `packages/kernel-node-runtime/src/io/socket-channel.ts` listens on
 * the socket as a server and accepts one connection at a time, so the
 * bridge plays the client role here.
 */

import { is } from '@metamask/superstruct';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

import type { Conversation } from './conversation.ts';
import { RequestStruct } from './protocol.ts';
import type { Reply } from './protocol.ts';

export type RunBridgeOptions = {
  /** Filesystem path of the Unix socket the kernel listens on. */
  socketPath: string;
  /** Conversation manager that handles ingest/query semantics. */
  conversation: Conversation;
  /** Optional logger; defaults to silent. */
  log?: (message: string) => void;
  /**
   * Delay between connect retries while the kernel is still bringing
   * the socket up. Default 500ms.
   */
  retryDelayMs?: number;
  /**
   * Maximum connect attempts before giving up. Default 60 (so the
   * default schedule waits up to 30 seconds total).
   */
  maxRetries?: number;
};

/**
 * Connect to the kernel's IOChannel socket and process messages until
 * the connection ends.
 *
 * @param options - Bridge options.
 */
export async function runBridge(options: RunBridgeOptions): Promise<void> {
  const {
    socketPath,
    conversation,
    log = () => undefined,
    retryDelayMs = 500,
    maxRetries = 60,
  } = options;

  const socket = await connectWithRetry({
    socketPath,
    retryDelayMs,
    maxRetries,
    log,
  });
  log(`connected to ${socketPath}`);

  let buffer = '';
  socket.setEncoding('utf8');
  for await (const chunk of socket) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (line.length === 0) {
        continue;
      }
      const reply = await handleLine(line, conversation, log);
      socket.write(`${JSON.stringify(reply)}\n`);
    }
  }
  log('connection closed');
}

/**
 * Connect to the socket, retrying with a fixed delay if it isn't ready
 * yet (the kernel may still be bringing the subcluster up).
 *
 * @param options - Connection options.
 * @param options.socketPath - Filesystem path to the socket.
 * @param options.retryDelayMs - Delay between attempts in ms.
 * @param options.maxRetries - Maximum number of attempts.
 * @param options.log - Logger.
 * @returns The connected socket.
 */
async function connectWithRetry(options: {
  socketPath: string;
  retryDelayMs: number;
  maxRetries: number;
  log: (message: string) => void;
}): Promise<Socket> {
  const { socketPath, retryDelayMs, maxRetries, log } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await connectOnce(socketPath);
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        log(`waiting for ${socketPath} to become available...`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs);
      });
    }
  }
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `could not connect to ${socketPath} after ${maxRetries} attempts: ${reason}`,
  );
}

/**
 * Single connect attempt; resolves once the socket fires `connect`.
 *
 * @param socketPath - Path to the Unix socket.
 * @returns The connected socket.
 */
async function connectOnce(socketPath: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onConnect = (): void => {
      // oxlint-disable-next-line typescript/no-use-before-define
      socket.removeListener('error', onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.removeListener('connect', onConnect);
      reject(error);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

/**
 * Parse one line of input, dispatch to the conversation, and produce
 * the reply object. Emits a one-line trace per request and per reply
 * so the operator can see the round-trip without grepping the
 * gateway's HTTP traffic.
 *
 * @param line - Raw JSON-encoded request line.
 * @param conversation - Conversation manager.
 * @param log - Logger.
 * @returns The reply object to write back to the kernel.
 */
async function handleLine(
  line: string,
  conversation: Conversation,
  log: (message: string) => void,
): Promise<Reply> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    log(`<- error: could not parse JSON: ${line}`);
    return { kind: 'error', message: `could not parse JSON: ${line}` };
  }
  if (!is(parsed, RequestStruct)) {
    log(`<- error: unrecognized request shape: ${line}`);
    return { kind: 'error', message: `unrecognized request shape: ${line}` };
  }
  log(`-> ${parsed.kind}: ${JSON.stringify(parsed)}`);
  try {
    if (parsed.kind === 'ingest') {
      await conversation.ingest(parsed);
      log(`<- ingested (${parsed.service.id})`);
      return { kind: 'ingested' };
    }
    const matches = await conversation.query(parsed.query);
    log(`<- matches: ${JSON.stringify(matches)}`);
    return { kind: 'matches', matches };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`<- error handling ${parsed.kind}: ${message}`);
    return { kind: 'error', message };
  }
}
