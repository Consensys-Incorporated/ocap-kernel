import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

/**
 * Build function for MaaS consumer.
 *
 * @param _vatPowers - Special powers granted to this vat (not used here).
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  _vatPowers: unknown,
  parameters: { name?: string },
  baggage: Baggage,
) {
  const name = parameters?.name ?? 'anonymous';
  // oxlint-disable-next-line no-console
  console.log(`buildRootObject "${name}"`);

  return makeDefaultExo('root', {
    async bootstrap(
      _vats: unknown,
      services: { ocapURLRedemptionService?: unknown },
    ) {
      // oxlint-disable-next-line no-console
      console.log(`vat ${name} is bootstrap`);
      const redeemer = services.ocapURLRedemptionService;
      if (!redeemer) {
        // oxlint-disable-next-line no-console
        console.log('no ocapURLRedemptionService found');
        throw Error('ocapURLRedemptionService not available');
      }
      baggage.init('redeemer', redeemer);
    },
    async setMaas(url: string) {
      if (!baggage.has('redeemer')) {
        throw Error('ocapURLRedemptionService not available');
      }
      const redeemer = baggage.get('redeemer');
      const maas = await E(redeemer).redeem(url);
      if (!maas) {
        throw Error(`unable to redeem ${url}`);
      }
      if (baggage.has('maas')) {
        baggage.set('maas', maas);
      } else {
        baggage.init('maas', maas);
      }
      baggage.init('previous', 0);
      const result = `MaaS service URL set to ${url}`;
      // oxlint-disable-next-line no-console
      console.log(result);
      return result;
    },
    async step() {
      if (!baggage.has('maas')) {
        const message = 'MaaS service address not set';
        // oxlint-disable-next-line no-console
        console.log(message);
        throw Error(message);
      }
      const maas = baggage.get('maas');
      const next = await E(maas).next(name);
      const previous = baggage.get('previous') as number;
      const result = `next step: ${String(next)} (last seen was ${previous})`;
      // oxlint-disable-next-line no-console
      console.log(result);
      baggage.set('previous', next);
      return result;
    },
  });
}
