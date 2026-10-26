import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Imported = { getValue: () => unknown };

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
  const tlog = (message: string, ...args: unknown[]): void =>
    logger(`${name}: ${message}`, ...args);

  let weakMap = new WeakMap<object, string>();

  const importedObjects = new Map<string, Imported>();

  /**
   * Print a message to the log.
   *
   * @param message - The message to print.
   */
  function log(message: string): void {
    // oxlint-disable-next-line no-console
    console.log(`${name}: ${message}`);
  }

  return makeDefaultExo('root', {
    bootstrap() {
      log(`bootstrap`);
      return `bootstrap-${name}`;
    },

    /**
     * Store an imported object by ID
     * keeping a strong reference and a weak map entry.
     *
     * @param obj - The imported object to store.
     * @param id - The ID to store the object under.
     * @returns The string 'stored'.
     */
    storeImport(obj: Imported, id = 'default') {
      tlog(`Storing import ${id}`, obj);
      importedObjects.set(id, obj);
      weakMap.set(obj, id);
      return 'stored';
    },

    /**
     * Use the imported object by ID and call its method.
     *
     * @param id - The ID of the object to use.
     * @returns The result of calling the object's method.
     */
    async useImport(id = 'default') {
      tlog(`useImport ${id}`);
      const obj = importedObjects.get(id);
      if (!obj) {
        throw new Error(`Object not found: ${id}`);
      }
      tlog(`Using import ${id}`);
      return E(obj).getValue();
    },

    /**
     * Make the reference to an imported object weak by
     * removing the strong reference, keeping only the weak one.
     *
     * @param id - The ID of the object to make weak.
     * @returns True if the object was successfully made weak, false if it doesn't exist.
     */
    makeWeak(id: string) {
      const obj = importedObjects.get(id);
      if (!obj) {
        tlog(`Cannot make weak reference to nonexistent object: ${id}`);
        return false;
      }
      tlog(`Making weak reference to ${id} (dropping strong ref)`);
      importedObjects.delete(id);
      return true;
    },

    /**
     * Completely forget about the imported object.
     * Once all vats forget it, retireImports() should trigger.
     *
     * @returns True if the object was successfully forgotten, false if it doesn't exist.
     */
    forgetImport() {
      weakMap = new WeakMap();
      return true;
    },

    /**
     * List all imported objects.
     *
     * @returns An array of all imported object IDs.
     */
    listImportedObjects() {
      return Array.from(importedObjects.keys());
    },

    /**
     * No-op method.
     *
     * @returns The string 'noop'.
     */
    noop() {
      return 'noop';
    },
  });
}
