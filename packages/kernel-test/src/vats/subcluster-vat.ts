import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * Build function for testing subcluster functionality.
 *
 * @param _vatPowers - Special powers granted to this vat.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @param parameters.subcluster - The subcluster for the vat.
 * @param _baggage - Root of vat's persistent state (not used here).
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  _vatPowers: unknown,
  parameters: { name?: string; subcluster?: string } = {},
  _baggage: unknown = null,
) {
  const name = parameters?.name ?? 'anonymous';
  const subcluster = parameters?.subcluster ?? 'default';

  /**
   * Print a message to the log.
   *
   * @param message - The message to print.
   */
  function log(message: string): void {
    // oxlint-disable-next-line no-console
    console.log(`${name}: ${message}`);
  }

  log(`buildRootObject`);
  log(`configuration parameters: ${JSON.stringify(parameters)}`);

  return makeDefaultExo('root', {
    async bootstrap() {
      log(`bootstrap() in ${subcluster}`);
      return 'bootstrap complete';
    },
  });
}
