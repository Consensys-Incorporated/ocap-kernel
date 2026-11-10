import { deleteDaemonState } from '@metamask/kernel-node-runtime/daemon';
import { isCapData, prettifySmallcaps } from '@metamask/kernel-utils';
import type { JsonRpcFailure } from '@metamask/utils';
import { isJsonRpcFailure } from '@metamask/utils';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getOcapHome } from '../ocap-home.ts';
import {
  isErrorWithCode,
  isProcessAlive,
  readPidFile,
  waitFor,
} from '../utils.ts';
import { pingDaemon, sendCommand } from './daemon-client.ts';
import { LLM_CONFIG_FILENAME } from './llm-config.ts';
import { ensureDaemon } from './daemon-spawn.ts';
import { getRelayAddrPath, getRelayPidPath } from './relay.ts';

const home = homedir();

/**
 * Format a JSON-RPC error for stderr and set exit code 1.
 *
 * @param response - The failed JSON-RPC response.
 */
function writeRpcError(response: JsonRpcFailure): void {
  process.stderr.write(
    `Error: ${response.error.message} (code ${String(response.error.code)})\n`,
  );
  process.exitCode = 1;
}

/**
 * Replace the home directory prefix with `~` for display.
 *
 * @param path - An absolute path.
 * @returns The path with the home prefix replaced.
 */
function tildefy(path: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Check if a value looks like a cluster config (has bootstrap + vats).
 *
 * @param value - The value to check.
 * @returns True if the value has bootstrap and vats fields.
 */
function isClusterConfigLike(
  value: unknown,
): value is { vats: Record<string, { bundleSpec?: string }> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'bootstrap' in value &&
    'vats' in value &&
    typeof (value as { vats: unknown }).vats === 'object'
  );
}

/**
 * Resolve relative bundleSpec paths in a cluster config to file:// URLs.
 *
 * @param config - The cluster config object.
 * @param config.vats - The vat configurations with optional bundleSpec paths.
 * @returns The config with resolved bundleSpec URLs.
 */
function resolveBundleSpecs(config: {
  vats: Record<string, { bundleSpec?: string }>;
}): unknown {
  const resolvedVats: Record<string, unknown> = {};
  for (const [vatName, vatConfig] of Object.entries(config.vats)) {
    const spec = vatConfig.bundleSpec;
    if (spec && !spec.includes('://')) {
      resolvedVats[vatName] = {
        ...vatConfig,
        bundleSpec: pathToFileURL(resolve(spec)).href,
      };
    } else {
      resolvedVats[vatName] = vatConfig;
    }
  }
  return { ...config, vats: resolvedVats };
}

/**
 * Stop the daemon via a `shutdown` RPC call. Falls back to PID + SIGTERM if
 * the socket is unresponsive, and escalates to SIGKILL if SIGTERM is ignored.
 *
 * @param socketPath - The daemon socket path.
 * @returns True if the daemon was stopped (or was not running), false if it
 * failed to stop within the timeout.
 */
export async function stopDaemon(socketPath: string): Promise<boolean> {
  const pidPath = join(getOcapHome(), 'daemon.pid');
  const pid = await readPidFile(pidPath);
  const processAlive = pid !== undefined && isProcessAlive(pid);
  const socketResponsive = await pingDaemon(socketPath);

  if (!socketResponsive && !processAlive) {
    if (pid !== undefined) {
      await rm(pidPath, { force: true });
    }
    process.stderr.write('Daemon is not running.\n');
    return true;
  }

  process.stderr.write('Stopping daemon...\n');

  let stopped = false;

  // Strategy 1: Graceful socket-based shutdown.
  if (socketResponsive) {
    try {
      await sendCommand({ socketPath, method: 'shutdown', timeoutMs: 10_000 });
    } catch {
      // Socket became unresponsive.
    }
    stopped = await waitFor(async () => !(await pingDaemon(socketPath)), 5_000);
  }

  // Strategy 2: SIGTERM.
  if (!stopped && pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      stopped = true;
    }
    if (!stopped) {
      stopped = await waitFor(() => !isProcessAlive(pid), 5_000);
    }
  }

  // Strategy 3: SIGKILL.
  if (!stopped && pid !== undefined) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      stopped = true;
    }
    if (!stopped) {
      stopped = await waitFor(() => !isProcessAlive(pid), 2_000);
    }
  }

  if (stopped) {
    await rm(pidPath, { force: true });
    process.stderr.write('Daemon stopped.\n');
  } else {
    process.stderr.write('Daemon did not stop within timeout.\n');
  }
  return stopped;
}

/**
 * Read the relay address from the relay address file.
 *
 * @returns The relay address, or undefined if the file is missing or empty.
 */
async function readRelayAddr(): Promise<string | undefined> {
  try {
    return (await readFile(getRelayAddrPath(), 'utf-8')).trim() || undefined;
  } catch (error: unknown) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Ensure the daemon is running and print its socket path.
 *
 * @param socketPath - The daemon socket path.
 * @param options - Additional options.
 * @param options.localRelay - Initialize remote comms with the local relay after starting.
 */
export async function handleDaemonStart(
  socketPath: string,
  { localRelay = false }: { localRelay?: boolean } = {},
): Promise<void> {
  if (localRelay) {
    const relayPid = await readPidFile(getRelayPidPath());
    if (relayPid === undefined || !isProcessAlive(relayPid)) {
      process.stderr.write(
        'Relay is not running. Start it with: ocap relay start\n',
      );
      process.exitCode = 1;
      return;
    }

    const relayAddr = await readRelayAddr();
    if (relayAddr === undefined) {
      process.stderr.write(
        'Relay address file not found. Restart the relay.\n',
      );
      process.exitCode = 1;
      return;
    }

    await ensureDaemon(socketPath);

    const statusResponse = await sendCommand({
      socketPath,
      method: 'getStatus',
      timeoutMs: 10_000,
    });
    if (
      !isJsonRpcFailure(statusResponse) &&
      (statusResponse.result as { remoteComms?: { state: string } }).remoteComms
        ?.state === 'connected'
    ) {
      process.stderr.write('Remote comms already initialized.\n');
      process.stderr.write(`Daemon running. Socket: ${tildefy(socketPath)}\n`);
      return;
    }

    const initResponse = await sendCommand({
      socketPath,
      method: 'initRemoteComms',
      params: { relays: [relayAddr] },
      timeoutMs: 30_000,
    });
    if (isJsonRpcFailure(initResponse)) {
      process.stderr.write(
        `Failed to initialize remote comms: ${initResponse.error.message}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write('Remote comms initialized with local relay.\n');
  } else {
    await ensureDaemon(socketPath);
  }
  process.stderr.write(`Daemon running. Socket: ${tildefy(socketPath)}\n`);
}

/**
 * Stop the daemon (if running) and delete all state.
 *
 * @param socketPath - The daemon socket path.
 */
export async function handleDaemonBegone(socketPath: string): Promise<void> {
  const stopped = await stopDaemon(socketPath);
  if (!stopped) {
    process.stderr.write(
      'Refusing to delete state while the daemon is still running.\n',
    );
    process.exitCode = 1;
    return;
  }
  await deleteDaemonState({ ocapHome: getOcapHome(), socketPath });
  // Not daemon state, but every later start would still read it, and need
  // the key it names.
  await rm(join(getOcapHome(), LLM_CONFIG_FILENAME), { force: true });
  process.stderr.write('All daemon state deleted.\n');
}

/**
 * Send an RPC method call to the daemon.
 *
 * @param args - Positional arguments: [method, params-json].
 * @param socketPath - The daemon socket path.
 * @param options - Additional options.
 * @param options.timeoutMs - Read timeout in milliseconds.
 */
export async function handleDaemonExec(
  args: string[],
  socketPath: string,
  { timeoutMs }: { timeoutMs?: number | undefined } = {},
): Promise<void> {
  const method = args[0] ?? 'getStatus';
  const rawParams = args[1];

  // For launchSubcluster: resolve relative bundleSpec paths to file:// URLs.
  let params: Record<string, unknown> | undefined;
  if (rawParams !== undefined) {
    try {
      const parsed = JSON.parse(rawParams) as Record<string, unknown>;
      const { config } = parsed as { config?: unknown };
      if (method === 'launchSubcluster' && isClusterConfigLike(config)) {
        params = {
          ...parsed,
          config: resolveBundleSpecs(config),
        };
      } else {
        params = parsed;
      }
    } catch {
      process.stderr.write('Error: params-json must be valid JSON.\n');
      process.exitCode = 1;
      return;
    }
  }

  const response = await sendCommand({
    socketPath,
    method,
    params,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  if (isJsonRpcFailure(response)) {
    writeRpcError(response);
    return;
  }

  const isTTY = process.stdout.isTTY ?? false;
  if (isTTY) {
    process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(response.result)}\n`);
  }
}

/**
 * Redeem an OCAP URL via the daemon.
 *
 * @param url - The OCAP URL to redeem.
 * @param socketPath - The daemon socket path.
 * @param options - Additional options.
 * @param options.timeoutMs - Read timeout in milliseconds.
 */
export async function handleRedeemURL(
  url: string,
  socketPath: string,
  { timeoutMs }: { timeoutMs?: number | undefined } = {},
): Promise<void> {
  const response = await sendCommand({
    socketPath,
    method: 'redeemOcapURL',
    params: { url },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  if (isJsonRpcFailure(response)) {
    writeRpcError(response);
    return;
  }

  process.stdout.write(`${JSON.stringify(response.result)}\n`);
}

/**
 * Send a `queueMessage` RPC call to the daemon and print the result.
 * By default the CapData result is decoded into a human-readable form.
 *
 * @param options - The command options.
 * @param options.target - KRef of the target object.
 * @param options.method - Method name to invoke.
 * @param options.args - JSON-encoded array of arguments.
 * @param options.socketPath - The daemon socket path.
 * @param options.raw - If true, output raw CapData JSON.
 * @param options.timeoutMs - Read timeout in milliseconds.
 */
export async function handleDaemonQueueMessage({
  target,
  method,
  args,
  socketPath,
  raw = false,
  timeoutMs,
}: {
  target: string;
  method: string;
  args: unknown[];
  socketPath: string;
  raw?: boolean | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
  const response = await sendCommand({
    socketPath,
    method: 'queueMessage',
    params: [target, method, args],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  if (isJsonRpcFailure(response)) {
    writeRpcError(response);
    return;
  }

  let output: unknown;
  if (raw || !isCapData(response.result)) {
    output = response.result;
  } else {
    output = prettifySmallcaps(response.result);
  }

  const isTTY = process.stdout.isTTY ?? false;
  if (isTTY) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}
