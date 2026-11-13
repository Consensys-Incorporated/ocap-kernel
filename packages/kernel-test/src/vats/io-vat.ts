import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { IOChannel, IOListener } from '@metamask/ocap-kernel';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * Build function for testing IO kernel services.
 *
 * The `repl` endowment is an `IOListener`, so the vat accepts connections
 * from it and keeps each one separately. `doRead`/`doWrite` name a
 * connection by index so a test can drive several peers independently.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: { name?: string } = {},
) {
  const name = parameters?.name ?? 'io-vat';
  const tlog = unwrapTestLogger(vatPowers, name);
  let listener: IOListener;
  const connections: IOChannel[] = [];
  const readBuffer: string[] = [];

  const getConnection = (index: number): IOChannel => {
    const connection = connections[index];
    if (connection === undefined) {
      throw new Error(`No connection at index ${index}`);
    }
    return connection;
  };

  return makeDefaultExo('root', {
    async bootstrap(_vats: unknown, services: { repl: IOListener }) {
      tlog('bootstrap');
      listener = services.repl;
    },
    /**
     * Accept the next waiting connection, appending it to the list.
     *
     * @returns The index of the accepted connection, or -1 on EOF.
     */
    async doAccept() {
      const connection = await E(listener).accept();
      if (!connection) {
        tlog('accept: listener closed');
        return -1;
      }
      connections.push(connection);
      const index = connections.length - 1;
      tlog(`accepted connection ${index}`);
      return index;
    },
    async doRead(index = 0) {
      const line = await E(getConnection(index)).read();
      tlog(`read[${index}]: ${line}`);
      readBuffer.push(String(line));
      return line;
    },
    async doWrite(data: string, index = 0) {
      await E(getConnection(index)).write(data);
      tlog(`wrote[${index}]: ${data}`);
    },
    async getReadBuffer() {
      return [...readBuffer];
    },
    async getConnectionCount() {
      return connections.length;
    },
  });
}
