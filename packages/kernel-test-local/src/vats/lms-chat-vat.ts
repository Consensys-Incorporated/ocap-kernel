import type { ERef } from '@endo/eventual-send';
import { makeChatClient } from '@metamask/kernel-language-model-service';
import type { ChatService } from '@metamask/kernel-language-model-service';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Logger } from '@metamask/logger';

/**
 * A vat that uses a kernel language model service to perform a chat completion
 * and logs the response. Used by lms-chat.test.ts and lms-chat.e2e.test.ts to verify the full
 * kernel → LMS service → Ollama round-trip.
 *
 * @param vatPowers - Vat powers, expected to include a logger.
 * @param parameters - Vat parameters.
 * @param parameters.model - The model to use for chat completion.
 * @returns A default Exo instance.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: Record<string, unknown>,
  { model }: { model: string },
) {
  const logger = vatPowers.logger as Logger;
  const tlog = (message: string): void => {
    logger.subLogger({ tags: ['test', 'lms-chat'] }).log(message);
  };

  return makeDefaultExo('root', {
    async bootstrap(
      _roots: unknown,
      { languageModelService }: { languageModelService: ERef<ChatService> },
    ) {
      const client = makeChatClient(languageModelService, model);
      const result = await client.chat.completions.create({
        messages: [
          { role: 'user', content: 'Reply with exactly one word: hello.' },
        ],
      });
      tlog(`lms-chat response: ${result.choices[0]?.message.content ?? ''}`);
    },
  });
}
