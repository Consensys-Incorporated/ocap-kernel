/**
 * Daemon communication layer shared by the OpenClaw plugins in this
 * monorepo. Spawns `ocap daemon redeem-url` and `ocap daemon queueMessage`
 * commands and returns parsed results.
 *
 * NOTE: this file is duplicated byte-for-byte in
 * `packages/agentmask/openclaw-plugin-metamask/daemon.ts` so each plugin
 * stays installable on its own via `openclaw plugins install -l`. Any
 * change here must be mirrored there; please keep them in sync.
 */
import { spawn } from 'node:child_process';

type ExecResult = { stdout: string; stderr: string; code: number | null };

/**
 * Spawn an ocap CLI command and collect its output.
 *
 * @param options - Spawn options.
 * @param options.cliPath - Path to the ocap CLI.
 * @param options.args - CLI arguments after `ocap`.
 * @param options.timeoutMs - Timeout in ms.
 * @returns The command result.
 */
async function spawnCli(options: {
  cliPath: string;
  args: string[];
  timeoutMs: number;
}): Promise<ExecResult> {
  const { cliPath, args, timeoutMs } = options;

  const command = cliPath.endsWith('.js') ? 'node' : cliPath;
  const spawnArgs = cliPath.endsWith('.js') ? [cliPath, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
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
        reject(new Error(`ocap CLI timed out after ${timeoutMs}ms`));
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
 * Throw an error from a failed CLI result.
 *
 * @param label - Description of the operation (for error messages).
 * @param result - The CLI execution result.
 */
function throwOnFailure(label: string, result: ExecResult): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${label} failed (exit ${result.code}): ${detail}`);
  }
}

export type DaemonCaller = {
  redeemUrl(url: string): Promise<string>;
  queueMessage(options: {
    target: string;
    method: string;
    args?: unknown[];
    raw?: boolean;
  }): Promise<unknown>;
};

/**
 * Create a daemon caller bound to CLI path, ocap home, and timeout.
 *
 * @param options - Daemon connection options.
 * @param options.cliPath - Path to the ocap CLI.
 * @param options.ocapHome - Optional `--home` directory passed to every
 * spawned `ocap` invocation. Use a distinct home (e.g.,
 * `~/.ocap-consumer`) to address a daemon other than the default
 * `~/.ocap`.
 * @param options.timeoutMs - Default timeout in ms.
 * @returns A daemon caller with `redeemUrl` and `queueMessage` methods.
 */
export function makeDaemonCaller(options: {
  cliPath: string;
  ocapHome?: string | undefined;
  timeoutMs: number;
}): DaemonCaller {
  const { cliPath, ocapHome, timeoutMs } = options;

  const homeArgs: string[] =
    ocapHome && ocapHome.length > 0 ? ['--home', ocapHome] : [];

  return {
    async redeemUrl(url: string): Promise<string> {
      const result = await spawnCli({
        cliPath,
        args: [...homeArgs, 'daemon', 'redeem-url', url],
        timeoutMs,
      });
      throwOnFailure('redeem-url', result);

      const raw = result.stdout.trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`redeem-url returned non-JSON output: ${raw}`);
      }

      if (typeof parsed !== 'string') {
        throw new Error(
          `redeem-url returned unexpected value: ${JSON.stringify(parsed)}`,
        );
      }
      return parsed;
    },

    async queueMessage(msgOptions: {
      target: string;
      method: string;
      args?: unknown[];
      raw?: boolean;
    }): Promise<unknown> {
      const args = msgOptions.args ?? [];
      const cliArgs = [
        ...homeArgs,
        'daemon',
        'queueMessage',
        msgOptions.target,
        msgOptions.method,
        JSON.stringify(args),
      ];
      if (msgOptions.raw) {
        cliArgs.push('--raw');
      }

      const result = await spawnCli({ cliPath, args: cliArgs, timeoutMs });
      throwOnFailure(`queueMessage ${msgOptions.method}`, result);

      const raw = result.stdout.trim();
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(
          `queueMessage ${msgOptions.method} returned non-JSON output: ${raw}`,
        );
      }
    },
  };
}
