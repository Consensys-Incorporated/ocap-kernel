/**
 * Daemon communication layer for the OpenClaw wallet plugin.
 *
 * Spawns `ocap daemon queueMessage` commands. The CLI auto-decodes CapData
 * via prettifySmallcaps, so no manual CapData unwrapping is needed here.
 */
import { spawn } from 'node:child_process';

type ExecResult = { stdout: string; stderr: string; code: number | null };

export type WalletCallOptions = {
  cliPath: string;
  walletKref: string;
  method: string;
  args: unknown[];
  timeoutMs: number;
};

/**
 * Bound wallet caller — pre-configured with CLI path, kref, and timeout.
 */
export type WalletCaller = (
  method: string,
  args: unknown[],
  timeoutMs?: number,
) => Promise<unknown>;

/**
 * Create a bound wallet caller from plugin config.
 *
 * @param options - Wallet connection options.
 * @param options.cliPath - Path to the ocap CLI.
 * @param options.walletKref - Kernel reference for the wallet coordinator.
 * @param options.timeoutMs - Default timeout in ms.
 * @returns A bound caller function.
 */
export function makeWalletCaller(options: {
  cliPath: string;
  walletKref: string;
  timeoutMs: number;
}): WalletCaller {
  const { cliPath, walletKref, timeoutMs } = options;
  return async (method, args, overrideTimeout) =>
    callWallet({
      cliPath,
      walletKref,
      method,
      args,
      timeoutMs: overrideTimeout ?? timeoutMs,
    });
}

/**
 * Run an `ocap daemon queueMessage` command and return its output.
 *
 * @param options - Execution options.
 * @param options.cliPath - Path to the ocap CLI.
 * @param options.walletKref - KRef of the target kernel object.
 * @param options.method - Method name to invoke.
 * @param options.argsJson - JSON-encoded array of arguments.
 * @param options.timeoutMs - Timeout in ms.
 * @returns The command result.
 */
async function runDaemonQueueMessage(options: {
  cliPath: string;
  walletKref: string;
  method: string;
  argsJson: string;
  timeoutMs: number;
}): Promise<ExecResult> {
  const { cliPath, walletKref, method, argsJson, timeoutMs } = options;
  const daemonArgs = ['daemon', 'queueMessage', walletKref, method, argsJson];

  // If cliPath points to a .js file, invoke it via node.
  const command = cliPath.endsWith('.js') ? 'node' : cliPath;
  const args = cliPath.endsWith('.js') ? [cliPath, ...daemonArgs] : daemonArgs;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } finally {
        reject(
          new Error(`ocap daemon queueMessage timed out after ${timeoutMs}ms`),
        );
      }
    }, timeoutMs);

    child.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? null });
    });
  });
}

/**
 * Call a wallet coordinator method via the OCAP daemon.
 *
 * The CLI's `daemon queueMessage` auto-decodes CapData via prettifySmallcaps,
 * so the output is already a decoded JSON value.
 *
 * @param options - Call options.
 * @returns The decoded response value.
 */
async function callWallet(options: WalletCallOptions): Promise<unknown> {
  const { cliPath, walletKref, method, args, timeoutMs } = options;
  const result = await runDaemonQueueMessage({
    cliPath,
    walletKref,
    method,
    argsJson: JSON.stringify(args),
    timeoutMs,
  });

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`Wallet ${method} failed (exit ${result.code}): ${detail}`);
  }

  const raw = result.stdout.trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(`Wallet ${method} returned non-JSON output`);
  }

  // prettifySmallcaps converts #error objects to "[ErrorName: msg]" strings,
  // but also converts manifest constants to "[undefined]", "[NaN]", etc.
  // Distinguish errors by checking for the ": " separator after the bracket.
  if (typeof decoded === 'string' && /^\[.+: /u.test(decoded)) {
    throw new Error(`Wallet ${method} failed: ${decoded}`);
  }

  return decoded;
}
