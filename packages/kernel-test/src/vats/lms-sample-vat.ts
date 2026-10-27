import type { ERef } from '@endo/eventual-send';
import { makeSampleClient } from '@metamask/kernel-language-model-service';
import type { SampleService } from '@metamask/kernel-language-model-service';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * A vat that uses a kernel language model service to perform a raw sample
 * completion and logs the response. Used to verify the full kernel → LMS
 * service round-trip for the sample path.
 *
 * @param vatPowers - The powers of the vat.
 * @param parameters - The parameters of the vat.
 * @param parameters.prompt - The prompt to sample from.
 * @returns A default Exo instance.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  { prompt = 'Hello' }: { prompt?: string } = {},
) {
  const tlog = unwrapTestLogger(vatPowers, 'lms-sample');
  return makeDefaultExo('root', {
    async bootstrap(
      _roots: unknown,
      { languageModelService }: { languageModelService: ERef<SampleService> },
    ) {
      const client = makeSampleClient(languageModelService, 'test');
      const result = await client.sample({ prompt });
      tlog(`response: ${result.text}`);
    },
  });
}
