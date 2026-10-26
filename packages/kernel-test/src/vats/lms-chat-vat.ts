import type { ERef } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import { makeChatClient } from '@ocap/kernel-language-model-service';
import type { ChatService } from '@ocap/kernel-language-model-service';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * A vat that uses a language model service to generate text.
 *
 * @param vatPowers - The powers of the vat.
 * @param parameters - The parameters of the vat.
 * @param parameters.name - The name of the vat.
 * @returns A default Exo instance.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  { name = 'anonymous' }: { name?: string } = {},
) {
  const tlog = unwrapTestLogger(vatPowers, name);
  const root = makeDefaultExo('root', {
    async bootstrap(
      _roots: unknown,
      { languageModelService }: { languageModelService: ERef<ChatService> },
    ) {
      const client = makeChatClient(languageModelService, 'test');
      const result = await client.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: `Hello, my name is ${name}. What is your name?`,
          },
        ],
      });
      tlog(`response: ${result.choices[0]?.message.content ?? ''}`);
    },
  });
  return root;
}
