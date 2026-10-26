import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { OcapURLRedemptionService } from '@metamask/ocap-kernel';

import type { TestPowers } from '../test-powers.ts';

type Importer = {
  storeImport: (obj: unknown, id: string) => unknown;
};

/**
 * Build function for a vat that gives a fresh object to a vat on another
 * kernel and keeps no reference to it.
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
  { logger }: TestPowers,
  parameters: { name?: string } = {},
  _baggage: unknown = null,
) {
  const name = parameters?.name ?? 'RemoteGift';
  logger.log(`buildRootObject "${name}"`);

  let redeemerService: OcapURLRedemptionService;
  // Kept so that the gift is the only object between the kernels that can be
  // collected.
  const importers = new Set<unknown>();

  return makeDefaultExo('remoteGiftRoot', {
    bootstrap(
      _vats: unknown,
      services: { ocapURLRedemptionService: OcapURLRedemptionService },
    ) {
      redeemerService = services.ocapURLRedemptionService;
      return `${name} bootstrap complete`;
    },

    /**
     * Send a new object to the `storeImport` method of the object an ocap URL
     * names.
     *
     * @param remoteURL - The URL of the remote importer.
     * @param id - The ID the importer is to store the object under.
     * @returns What the importer answered.
     */
    async giveGift(remoteURL: string, id: string) {
      const importer = (await E(redeemerService).redeem(remoteURL)) as Importer;
      importers.add(importer);
      const gift = makeDefaultExo('gift', {
        getValue() {
          return id;
        },
      });
      return E(importer).storeImport(gift, id);
    },

    noop() {
      return 'noop';
    },
  });
}
