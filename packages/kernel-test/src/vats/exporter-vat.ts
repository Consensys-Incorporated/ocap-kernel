import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * Build function for vats that will run various tests.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param vatPowers.logger - The logger for the vat.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @param _baggage - Root of vat's persistent state (not used here).
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: { name?: string } = {},
  _baggage: unknown = null,
) {
  const name = parameters?.name ?? 'anonymous';
  const logger = unwrapTestLogger(vatPowers, name);
  const tlog = (message: string): void => logger(`${name}: ${message}`);

  /**
   * Print a message to the log.
   *
   * @param message - The message to print.
   */
  function log(message: string): void {
    // oxlint-disable-next-line no-console
    console.log(`${name}: ${message}`);
  }

  const exportedObjects = new Map<string, unknown>();

  return makeDefaultExo('root', {
    bootstrap() {
      log(`bootstrap`);
      return `bootstrap-${name}`;
    },

    // Create an object in our maps
    createObject(id: string) {
      const obj = makeDefaultExo('SharedObject', {
        getValue() {
          return id;
        },
      });
      exportedObjects.set(id, obj);
      tlog(`Created object ${id}`);
      return obj;
    },

    // Check if an object exists in our maps
    isObjectPresent(objId: string) {
      return exportedObjects.has(objId);
    },

    // Remove an object from our tracking, allowing it to be GC'd
    forgetObject(objId: string) {
      if (exportedObjects.has(objId)) {
        tlog(`Forgetting object ${objId}`);
        exportedObjects.delete(objId);
        return true;
      }
      tlog(`Cannot forget nonexistent object: ${objId}`);
      return false;
    },

    // No-op to help trigger crank cycles
    noop() {
      return 'noop';
    },
  });
}
