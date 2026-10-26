import '@metamask/kernel-shims/endoify-node';
import { makeStreams } from '../../dist/vat/streams.js';

main().catch(console.error);

/**
 * The main function for the test worker.
 * No supervisor is created, but the stream is synchronized for comms testing.
 */
async function main() {
  await makeStreams();
}
