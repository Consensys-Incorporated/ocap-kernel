import type { Logger } from '@metamask/logger';

import { CapabilityResultMessage } from './messages.ts';
import type { AssistantMessage, Transcript } from './messages.ts';
import type { CapabilityRecord } from '../../types.ts';

export const makeEvaluator =
  ({
    capabilities = {},
    logger,
  }: {
    capabilities?: CapabilityRecord;
    logger?: Logger;
  }) =>
  async (
    history: Transcript,
    message: AssistantMessage,
  ): Promise<CapabilityResultMessage | null> => {
    // Validate the message.
    const invocations = message.messageBody.invoke;
    if (!invocations) {
      throw new Error('No invoke in message');
    }
    if (invocations.length === 0) {
      throw new Error('Empty invocation list in message');
    }

    const results = await Promise.all(
      invocations.map(async ({ name, args }) => ({
        name,
        args,
        result: await (async () => {
          const toInvoke = capabilities[name];
          if (!toInvoke) {
            throw new Error(`Invoked capability ${name} not found`);
          }
          return await toInvoke.func(args as never);
        })(),
      })),
    );
    logger?.info('results:', results);
    const resultMessage = new CapabilityResultMessage(results);
    history.push(message, resultMessage);
    return resultMessage;
  };
