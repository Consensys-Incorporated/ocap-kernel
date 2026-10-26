import type { Logger } from '@metamask/logger';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import serveMiddleware from 'serve-handler';

import type { Config } from '../config.ts';

/**
 * Get a static server for development purposes.
 *
 * @param config - The config object.
 * @param logger - Optional logger for output.
 * @returns An object with a `listen` method that returns a promise that
 * resolves when the server is listening.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getServer(config: Config, logger?: Logger) {
  if (!config.dir) {
    throw new Error(`Config option 'dir' must be specified.`);
  }
  const bundleRoot = resolvePath(config.dir);
  // Only serve .bundle files
  const isAllowedPath = (path?: string): boolean =>
    typeof path === 'string' && path.endsWith('.bundle');

  /**
   * Get the response for a request. This is extracted into a function so that
   * we can easily catch errors and send a 500 response.
   *
   * @param request - The request.
   * @param response - The response.
   * @returns A promise that resolves when the response is sent.
   */
  async function getResponse(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname =
      request.url &&
      request.headers.host &&
      new URL(request.url, `http://${request.headers.host}`).pathname;
    const path = pathname?.slice(1);

    if (!isAllowedPath(path)) {
      response.statusCode = 404;
      response.end();
      return;
    }

    await serveMiddleware(request, response, {
      public: bundleRoot,
      directoryListing: false,
      headers: [
        {
          source: '**/*',
          headers: [
            {
              key: 'Cache-Control',
              value: 'no-cache',
            },
            {
              key: 'Access-Control-Allow-Origin',
              value: '*',
            },
          ],
        },
      ],
    });
  }

  const server = createServer((request, response) => {
    getResponse(request, response).catch(
      /* istanbul ignore next */
      (error) => {
        logger?.error(error);
        response.statusCode = 500;
        response.end();
      },
    );
  });

  /**
   * Start the server on the port specified in the config.
   *
   * @param port - The port to listen on.
   * @returns A promise that resolves when the server is listening. The promise
   * resolves to an object with the port and the server instance. Note that if
   * the `config.server.port` is `0`, the OS will choose a random port for us,
   * so we need to get the port from the server after it starts.
   */
  // oxlint-disable-next-line typescript/explicit-function-return-type
  const listen = async (port = config.server.port) => {
    return new Promise<{
      port: number;
      server: Server;
      close: () => Promise<void>;
    }>((resolve, reject) => {
      try {
        server.listen(port, () => {
          const close = promisify(server.close.bind(server));
          const address = server.address() as AddressInfo;
          resolve({ port: address.port, server, close });
        });
      } catch (listenError) {
        reject(listenError as Error);
      }
    });
  };

  return { listen };
}
