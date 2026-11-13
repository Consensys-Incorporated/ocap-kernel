import '@metamask/kernel-shims/endoify';
import { NodeWorkerDuplexStream } from '@metamask/streams';
import { parentPort } from 'node:worker_threads';

import { Logger, makeStreamTransport } from '../../dist/index.js';

main().catch(console.error);

/**
 * The main function for the worker.
 */
async function main() {
  const stream = await NodeWorkerDuplexStream.make(parentPort);
  const logger = new Logger({
    tags: ['test'],
    transports: [makeStreamTransport(stream)],
  });
  logger.debug('Hello, world!');
}
