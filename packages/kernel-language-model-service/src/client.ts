import { E } from '@endo/eventual-send';
import type { ERef } from '@endo/eventual-send';
import { ifDefined } from '@metamask/kernel-utils';

import type {
  ChatParams,
  ChatResult,
  ChatService,
  LanguageModel,
  SampleParams,
  SampleResult,
  SampleService,
} from './types.ts';

/**
 * Parameters accepted by `makeChatClient`'s `create`. Streaming is not
 * offered: a stream cannot be passed across the kernel marshal boundary.
 */
export type ChatClientParams = Omit<ChatParams, 'model' | 'stream'> & {
  model?: string;
};

/**
 * Wraps a remote service reference with Open /v1-style chat completion ergonomics.
 *
 * Usage:
 * ```ts
 * const client = makeChatClient(lmsRef, 'gpt-4o');
 * const result = await client.chat.completions.create({ messages });
 * ```
 *
 * @param lmsRef - Reference to a service with a `chat` method.
 * @param defaultModel - Default model name used when params do not specify one.
 * @returns A client object with `chat.completions.create`.
 */
export const makeChatClient = (
  lmsRef: ERef<ChatService>,
  defaultModel?: string,
): {
  chat: {
    completions: {
      create(params: ChatClientParams): Promise<ChatResult>;
    };
  };
} => {
  /**
   * @param params - Chat completion parameters.
   * @returns A promise resolving to the full chat result.
   */
  async function create(params: ChatClientParams): Promise<ChatResult> {
    const model = params.model ?? defaultModel;
    if (!model) {
      throw new Error('model is required');
    }
    return E(lmsRef).chat(harden({ ...params, model }));
  }

  return harden({ chat: { completions: { create } } });
};

/**
 * Wraps a remote service reference with raw token-prediction ergonomics.
 *
 * Usage:
 * ```ts
 * const client = makeSampleClient(lmsRef, 'llama3');
 * const result = await client.sample({ prompt: 'Once upon' });
 * ```
 *
 * @param lmsRef - Reference to a service with a `sample` method.
 * @param defaultModel - Default model name used when params do not specify one.
 * @returns A client object with `sample`.
 */
export const makeSampleClient = (
  lmsRef: ERef<SampleService>,
  defaultModel?: string,
): {
  sample: (
    params: Omit<SampleParams, 'model'> & { model?: string },
  ) => Promise<SampleResult>;
} =>
  harden({
    async sample(
      params: Omit<SampleParams, 'model'> & { model?: string },
    ): Promise<SampleResult> {
      const model = params.model ?? defaultModel;
      if (!model) {
        throw new Error('model is required');
      }
      return E(lmsRef).sample(harden({ ...params, model }));
    },
  });

/**
 * Wrap a remote service reference as a {@link LanguageModel} for a sampling
 * agent strategy, which reads its answer as a stream. The service answers a
 * sample in one piece, since a stream cannot be passed across the kernel
 * marshal boundary, so the whole answer becomes the only chunk and the model
 * runs until it stops on its own.
 *
 * @param args - The arguments.
 * @param args.lmsRef - Reference to a service with a `sample` method.
 * @param args.model - The model to sample from.
 * @param args.maxTokens - A cap on tokens per sample, for a model that would
 * otherwise continue past what the agent needed.
 * @returns The language model.
 */
export const makeSampleLanguageModel = ({
  lmsRef,
  model,
  maxTokens,
}: {
  lmsRef: ERef<SampleService>;
  model: string;
  maxTokens?: number;
}): LanguageModel<unknown, { response: string }> => {
  const client = makeSampleClient(lmsRef, model);
  return harden({
    getInfo: async () => ({ model, options: {} }),
    load: async () => undefined,
    unload: async () => undefined,
    sample: async (prompt: string) => {
      const { text } = await client.sample({
        prompt,
        ...ifDefined({ max_tokens: maxTokens }),
      });
      return {
        stream: (async function* () {
          yield { response: text };
        })(),
        abort: async () => undefined,
      };
    },
  });
};
