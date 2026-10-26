import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type {
  OcapURLIssuerService,
  OcapURLRedemptionService,
} from '@metamask/ocap-kernel';

import type { TestPowers } from '../test-powers.ts';

/**
 * Build function for vat that sends remote messages to other kernels.
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
  const name = parameters?.name ?? 'RemoteSender';
  logger.log(`buildRootObject "${name}"`);

  let issuerService: OcapURLIssuerService | undefined;
  let redeemerService: OcapURLRedemptionService | undefined;

  return makeDefaultExo('remoteSenderRoot', {
    async bootstrap(
      vats: { receiver?: unknown },
      services: {
        ocapURLIssuerService?: OcapURLIssuerService;
        ocapURLRedemptionService?: OcapURLRedemptionService;
      },
    ) {
      logger.log(`vat ${name} is bootstrap`);
      issuerService = services.ocapURLIssuerService;
      redeemerService = services.ocapURLRedemptionService;

      if (issuerService && vats.receiver) {
        const url = await E(issuerService).issue(vats.receiver);
        logger.log(`url for receiver: ${url}`);
        return { message: `${name} bootstrap complete`, ocapURL: url };
      }

      return { message: `${name} bootstrap complete` };
    },

    async sendMessage(remoteURL: string, method: string, args: unknown[] = []) {
      logger.log(`${name} attempting to redeem URL: ${remoteURL}`);

      if (redeemerService) {
        const remoteObject = (await E(redeemerService).redeem(
          remoteURL,
        )) as Record<string, (...methodArgs: unknown[]) => unknown>;
        logger.log(`${name} redeemed URL successfully`);
        const result = await E(remoteObject)[method]?.(...args);
        logger.log(`${name} got result:`, result);
        return result;
      }

      logger.log('no ocapURLRedemptionService found');
      throw new Error('ocapURLRedemptionService not available');
    },

    hello(from: string) {
      const message = `${name} received hello from ${from}`;
      logger.log(message);
      return message;
    },
  });
}
