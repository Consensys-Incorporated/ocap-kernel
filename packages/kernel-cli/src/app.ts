import '@metamask/kernel-shims/endoify-node';
import { Logger } from '@metamask/logger';
import type { LogEntry } from '@metamask/logger';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { bundleSource } from './commands/bundle.ts';
import { getSocketPath } from './commands/daemon-client.ts';
import { ensureDaemon } from './commands/daemon-spawn.ts';
import {
  handleDaemonBegone,
  handleDaemonExec,
  handleDaemonQueueMessage,
  handleDaemonStart,
  handleRedeemURL,
  stopDaemon,
} from './commands/daemon.ts';
import {
  printRelayStatus,
  startRelayWithBookkeeping,
  stopRelay,
} from './commands/relay.ts';
import { getServer } from './commands/serve.ts';
import { watchDir } from './commands/watch.ts';
import { defaultConfig } from './config.ts';
import type { Config } from './config.ts';
import { parseTimeoutMs, withTimeout } from './utils.ts';

/**
 * Console transport that omits tags from output.
 *
 * @param entry - The log entry to write.
 */
function consoleTransport(entry: LogEntry): void {
  const args = [
    ...(entry.message ? [entry.message] : []),
    ...(entry.data ?? []),
  ];
  console[entry.level](...args);
}

const logger = new Logger({ tags: ['cli'], transports: [consoleTransport] });

const yargsInstance = yargs(hideBin(process.argv))
  .scriptName('ocap')
  .usage('$0 <command> [options]')
  .demandCommand(1)
  .strict()
  .option('home', {
    type: 'string',
    describe:
      'OCAP home directory for this invocation (overrides $OCAP_HOME). ' +
      'Use distinct values to run independent daemons side by side.',
    global: true,
  })
  .middleware((args) => {
    if (typeof args.home === 'string' && args.home.length > 0) {
      process.env.OCAP_HOME = path.resolve(args.home);
    }
  })
  .command(
    'bundle <targets..>',
    'Bundle user code to be used in a vat',
    (_yargs) =>
      _yargs.option('targets', {
        type: 'string',
        file: true,
        dir: true,
        array: true,
        demandOption: true,
        describe: 'The files or directories of files to bundle',
      }),
    async (args) => {
      await Promise.all(
        args.targets.map(async (target) => bundleSource(target, logger)),
      );
    },
  )
  .command(
    'serve <dir> [options]',
    'Serve bundled user code by filename',
    (_yargs) =>
      _yargs
        .option('dir', {
          type: 'string',
          dir: true,
          required: true,
          describe: 'A directory containing bundle files to serve',
        })
        .option('port', {
          alias: 'p',
          type: 'number',
          default: defaultConfig.server.port,
        }),
    async (args) => {
      const appName = 'bundle server';
      const url = `http://localhost:${args.port}`;
      const resolvedDir = path.resolve(args.dir);
      const config: Config = {
        server: {
          port: args.port,
        },
        dir: resolvedDir,
      };
      logger.info(`Starting ${appName} in ${resolvedDir} on ${url}`);
      const server = getServer(config, logger);
      await server.listen();
    },
  )
  .command(
    'watch <dir>',
    'Bundle all .js files in the target dirs and rebundle on change.',
    (_yargs) =>
      _yargs.option('dir', {
        type: 'string',
        dir: true,
        required: true,
        describe: 'The directory to watch',
      }),
    (args) => {
      const { ready, error } = watchDir(args.dir, logger);
      let handleClose: undefined | (() => Promise<void>);

      ready
        .then((close) => {
          handleClose = close;
          logger.info(`Watching ${args.dir}...`);
          return undefined;
        })
        .catch(logger.error);

      error.catch(async (reason) => {
        logger.error(reason);
        // If watching started, close the watcher.
        return handleClose ? withTimeout(handleClose(), 400) : undefined;
      });
    },
  )
  .command(
    'start <dir> [-p port]',
    'Watch the target directory and serve from it on the given port.',
    (_yargs) =>
      _yargs
        .option('dir', {
          type: 'string',
          dir: true,
          required: true,
          describe: 'A directory containing source files to bundle and serve',
        })
        .option('port', {
          alias: 'p',
          type: 'number',
          default: defaultConfig.server.port,
        }),
    async (args) => {
      const closeHandlers: (() => Promise<void>)[] = [];
      const resolvedDir = path.resolve(args.dir);

      const handleClose = async (): Promise<void> => {
        await Promise.all(
          closeHandlers.map(async (close) => withTimeout(close(), 400)),
        );
      };

      const { ready: watchReady, error: watchError } = watchDir(
        resolvedDir,
        logger,
      );

      watchError.catch(async (reason) => {
        logger.error(reason);
        await handleClose();
      });

      const closeWatcher = await watchReady;
      closeHandlers.push(closeWatcher);

      const server = getServer(
        {
          server: {
            port: args.port,
          },
          dir: resolvedDir,
        },
        logger,
      );
      const { close: closeServer, port } = await server.listen();
      closeHandlers.push(closeServer);

      logger.info(`Bundling and serving ${resolvedDir} on localhost:${port}`);
    },
  )
  .command(
    'relay',
    'Manage the relay server',
    (_yargs) =>
      _yargs
        .command(
          ['start', '$0'],
          'Start the relay server',
          (_y) =>
            _y.option('public-ip', {
              type: 'string',
              describe:
                'Public IPv4 to announce in addition to locally-bound ' +
                'addresses. Defaults to $LIBP2P_RELAY_PUBLIC_IP. Use on a ' +
                'NAT-backed VPS where the public address is not on a ' +
                'local NIC.',
            }),
          async (args) => {
            const cliIp =
              typeof args['public-ip'] === 'string' && args['public-ip'] !== ''
                ? args['public-ip']
                : undefined;
            const envIp = process.env.LIBP2P_RELAY_PUBLIC_IP;
            const publicIp = cliIp ?? (envIp === '' ? undefined : envIp);
            await startRelayWithBookkeeping(
              logger,
              publicIp ? { publicIp } : {},
            );
          },
        )
        .command(
          'status',
          'Print whether the relay is running',
          (_y) => _y,
          async () => {
            await printRelayStatus();
          },
        )
        .command(
          'stop',
          'Stop the relay server',
          (_y) =>
            _y.option('force', {
              type: 'boolean',
              default: false,
              describe: 'Send SIGKILL if SIGTERM fails to stop the relay',
            }),
          async (args) => {
            const stopped = await stopRelay({ force: args.force });
            if (!stopped) {
              process.exitCode = 1;
            }
          },
        ),
    () => {
      // Handled by subcommands.
    },
  )
  .command(
    'daemon',
    'Manage the OCAP daemon process',
    (_yargs) => {
      // NB: do not call getSocketPath() here. The builder runs at
      // parse time, before --home middleware has updated $OCAP_HOME.
      // Each handler resolves the socket path itself so per-invocation
      // home overrides are honored.
      return _yargs
        .command(
          ['start', '$0'],
          'Start the daemon (or confirm it is running)',
          (_y) =>
            _y.option('local-relay', {
              type: 'boolean',
              default: false,
              describe:
                'Initialize remote comms with the local relay after starting',
            }),
          async (args) => {
            await handleDaemonStart(getSocketPath(), {
              localRelay: args['local-relay'],
            });
          },
        )
        .command(
          'stop',
          'Stop the daemon',
          (_y) => _y,
          async () => {
            const stopped = await stopDaemon(getSocketPath());
            if (!stopped) {
              process.exitCode = 1;
            }
          },
        )
        .command(
          ['purge', 'begone'],
          'Stop the daemon and delete all state',
          (_y) =>
            _y.option('force', {
              describe: 'Confirm state deletion',
              type: 'boolean',
              demandOption: true,
            }),
          async (args) => {
            if (!args.force) {
              process.stderr.write(
                'Usage: ocap daemon purge --force\n' +
                  'This will delete all OCAP daemon state.\n',
              );
              process.exitCode = 1;
              return;
            }
            await handleDaemonBegone(getSocketPath());
          },
        )
        .command(
          'exec [method] [params-json]',
          'Send an RPC method call to the daemon',
          (_y) =>
            _y
              .positional('method', {
                describe: 'RPC method name (defaults to getStatus)',
                type: 'string',
              })
              .positional('params-json', {
                describe: 'JSON-encoded method parameters',
                type: 'string',
              })
              .example('$0 daemon exec', 'Get daemon status')
              .example(
                '$0 daemon exec getStatus',
                'Get daemon status (explicit)',
              )
              .example(
                '$0 daemon exec pingVat \'{"vatId":"v1"}\'',
                'Ping a vat',
              )
              .example(
                '$0 daemon exec executeDBQuery \'{"sql":"SELECT * FROM kv LIMIT 5"}\'',
                'Run a SQL query (requires a daemon started with OCAP_DEV_MODE=true)',
              )
              .option('timeout', {
                describe: 'Read timeout in seconds (default: no timeout)',
                type: 'number',
              })
              .example(
                '$0 daemon exec terminateVat \'{"vatId":"v1"}\'',
                'Terminate a vat',
              ),
          async (args) => {
            const execArgs: string[] = [];
            if (args.method) {
              execArgs.push(String(args.method));
            }
            if (args['params-json']) {
              execArgs.push(String(args['params-json']));
            }
            const socketPath = getSocketPath();
            await ensureDaemon(socketPath);
            const timeoutMs = parseTimeoutMs(args.timeout);
            await handleDaemonExec(
              execArgs,
              socketPath,
              timeoutMs === undefined ? {} : { timeoutMs },
            );
          },
        )
        .command(
          'redeem-url <url>',
          'Redeem an OCAP URL and print the resulting kref',
          (_y) =>
            _y
              .positional('url', {
                describe: 'The OCAP URL to redeem (e.g., ocap:...@...)',
                type: 'string',
                demandOption: true,
              })
              .option('timeout', {
                describe: 'Read timeout in seconds (default: no timeout)',
                type: 'number',
              })
              .example(
                '$0 daemon redeem-url ocap:abc123@12D3KooW...,/ip4/...',
                'Redeem an OCAP URL',
              ),
          async (args) => {
            const socketPath = getSocketPath();
            await ensureDaemon(socketPath);
            await handleRedeemURL(args.url, socketPath, {
              timeoutMs: parseTimeoutMs(args.timeout),
            });
          },
        )
        .command(
          'queueMessage <target> <method> [args-json]',
          'Send a message to a kernel object and decode the CapData result',
          (_y) =>
            _y
              .positional('target', {
                describe: 'KRef of the target object',
                type: 'string',
                demandOption: true,
              })
              .positional('method', {
                describe: 'Method name to invoke',
                type: 'string',
                demandOption: true,
              })
              .positional('args-json', {
                describe: 'JSON-encoded array of arguments (default: [])',
                type: 'string',
              })
              .option('raw', {
                describe: 'Output raw CapData instead of decoded result',
                type: 'boolean',
                default: false,
              })
              .option('timeout', {
                describe: 'Read timeout in seconds (default: no timeout)',
                type: 'number',
              })
              .example(
                '$0 daemon queueMessage ko123 getBalance',
                'Call getBalance with no args',
              )
              .example(
                '$0 daemon queueMessage ko123 transfer \'["ko456", 100]\'',
                'Call transfer with args',
              )
              .example(
                '$0 daemon queueMessage ko123 getBalance --raw',
                'Get raw CapData output',
              ),
          async (args) => {
            let parsedArgs: unknown[] = [];
            if (args['args-json']) {
              try {
                const parsed: unknown = JSON.parse(String(args['args-json']));
                if (!Array.isArray(parsed)) {
                  process.stderr.write(
                    'Error: args-json must be a JSON array.\n',
                  );
                  process.exitCode = 1;
                  return;
                }
                parsedArgs = parsed;
              } catch {
                process.stderr.write('Error: args-json must be valid JSON.\n');
                process.exitCode = 1;
                return;
              }
            }
            const socketPath = getSocketPath();
            await ensureDaemon(socketPath);
            await handleDaemonQueueMessage({
              target: String(args.target),
              method: String(args.method),
              args: parsedArgs,
              socketPath,
              raw: args.raw,
              timeoutMs: parseTimeoutMs(args.timeout),
            });
          },
        );
    },
    () => {
      // Handled by subcommands.
    },
  );

await yargsInstance.help('help').parse();
