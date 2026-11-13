import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { OcapURLIssuerService } from '@metamask/ocap-kernel';

import type { TestPowers } from '../test-powers.ts';

/**
 * Build function for a vat that exports two objects — a revocable target and an
 * unrelated bystander — so cross-kernel revocation tests can check both sides.
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
  const name = parameters?.name ?? 'RevocationTarget';
  logger.log(`buildRootObject "${name}"`);

  const target = makeDefaultExo('target', {
    ping() {
      return `pong from ${name} target`;
    },
  });

  const bystander = makeDefaultExo('bystander', {
    ping() {
      return `pong from ${name} bystander`;
    },
  });

  return makeDefaultExo('root', {
    async bootstrap(
      _vats: unknown,
      services: { ocapURLIssuerService: OcapURLIssuerService },
    ) {
      logger.log(`vat ${name} is bootstrap`);
      const issuerService = services.ocapURLIssuerService;
      const targetURL = await E(issuerService).issue(target);
      const bystanderURL = await E(issuerService).issue(bystander);
      return harden({ targetURL, bystanderURL });
    },

    getTarget() {
      return target;
    },

    getBystander() {
      return bystander;
    },
  });
}
