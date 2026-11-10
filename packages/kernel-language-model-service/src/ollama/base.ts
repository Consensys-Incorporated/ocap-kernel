import { ifDefined } from '@metamask/kernel-utils';
import type {
  AbortableAsyncIterator,
  GenerateResponse,
  ListResponse,
} from 'ollama';

import type {
  AssistantMessage,
  ChatParams,
  ChatResult,
  LanguageModelService,
  SampleParams,
  SampleResult,
} from '../types.ts';
import { parseModelConfig } from './parse.ts';
import type {
  OllamaInstanceConfig,
  OllamaModel,
  OllamaClient,
  OllamaModelOptions,
  OllamaTool,
} from './types.ts';
import { parseToolArguments } from '../utils/parse-tool-arguments.ts';

/**
 * Result of a streaming raw token-prediction request.
 */
export type SampleStreamResult = {
  stream: AsyncIterable<GenerateResponse>;
  abort: () => Promise<void>;
};

/**
 * Base service for interacting with Ollama language models.
 * Provides a generic interface for creating and managing Ollama model instances.
 * This class implements the LanguageModelService interface and handles the
 * creation of hardened model instances that can be safely passed between vats.
 *
 * @template Ollama - The type of Ollama client to use
 */
export class OllamaBaseService<
  Ollama extends OllamaClient,
> implements LanguageModelService<
  OllamaModelOptions,
  OllamaModelOptions,
  GenerateResponse
> {
  readonly #makeClient: () => Promise<Ollama>;

  /**
   * Creates a new Ollama base service.
   *
   * @param makeClient - Factory function that creates an Ollama client instance
   */
  constructor(makeClient: () => Promise<Ollama>) {
    this.#makeClient = makeClient;
  }

  /**
   * Retrieves a list of available models from the Ollama server.
   *
   * @returns A promise that resolves to the list of available models
   */
  async getModels(): Promise<ListResponse> {
    const client = await this.#makeClient();
    return await client.list();
  }

  /**
   * Performs a chat completion request via the Ollama chat API.
   *
   * @param params - The chat parameters.
   * @returns A hardened chat result.
   */
  async chat(params: ChatParams): Promise<ChatResult> {
    const { model, messages, tools, temperature, seed, stop } = params;
    const ollama = await this.#makeClient();
    let stopArr: string[] | undefined;
    if (stop !== undefined) {
      stopArr = Array.isArray(stop) ? stop : [stop];
    }
    const response = await ollama.chat({
      model,
      messages: messages.map((chatMessage) => {
        if (chatMessage.role === 'tool') {
          return {
            role: 'tool' as const,
            content: chatMessage.content,
            tool_call_id: chatMessage.tool_call_id,
          };
        }
        if (chatMessage.role === 'assistant') {
          return {
            role: 'assistant' as const,
            content: chatMessage.content ?? '',
            ...(chatMessage.tool_calls && {
              tool_calls: chatMessage.tool_calls.map(({ function: fn }) => ({
                function: {
                  name: fn.name,
                  arguments: parseToolArguments(fn.arguments),
                },
              })),
            }),
          };
        }
        return { role: chatMessage.role, content: chatMessage.content };
      }),
      ...(tools && { tools: tools as OllamaTool[] }),
      stream: false,
      options: ifDefined({
        temperature,
        top_p: params.top_p,
        seed,
        num_predict: params.max_tokens,
        stop: stopArr,
      }),
    });
    const promptTokens = response.prompt_eval_count ?? 0;
    const completionTokens = response.eval_count ?? 0;
    const { tool_calls: responseToolCalls } = response.message;
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: response.message.content,
      ...(responseToolCalls && {
        tool_calls: responseToolCalls.map((tc, index) => ({
          id: `tool-${index}`,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
          },
        })),
      }),
    };
    return harden({
      id: 'ollama-chat',
      model: response.model,
      choices: [
        {
          message: assistantMessage,
          index: 0,
          finish_reason: response.done_reason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  }

  /**
   * Performs a raw token-prediction request via Ollama's generate API with raw=true,
   * bypassing the model's chat template.
   *
   * When `params.stream` is `true`, returns a streaming result with an async
   * iterable of {@link GenerateResponse} chunks and an abort handle.
   * When `params.stream` is `false` or omitted, awaits and returns the full
   * {@link SampleResult}.
   *
   * @param params - The raw sample parameters.
   * @returns A streaming result when `stream: true`, or the full result otherwise.
   */
  sample(params: SampleParams & { stream: true }): Promise<SampleStreamResult>;

  /**
   * @param params - The raw sample parameters.
   * @returns A promise resolving to the full sample result.
   */
  sample(params: SampleParams & { stream?: false }): Promise<SampleResult>;

  /**
   * @param params - The raw sample parameters.
   * @returns A streaming result or full result depending on `params.stream`.
   */
  async sample(
    params: SampleParams & { stream?: boolean },
  ): Promise<SampleResult | SampleStreamResult> {
    if (params.stream === true) {
      return this.#streamingSample(params);
    }
    return this.#nonStreamingSample(params);
  }

  /**
   * @param params - The raw sample parameters.
   * @returns A promise resolving to the full sample result.
   */
  async #nonStreamingSample(params: SampleParams): Promise<SampleResult> {
    const ollama = await this.#makeClient();
    const response = await ollama.generate({
      model: params.model,
      prompt: params.prompt,
      raw: true,
      stream: false,
      options: this.#buildSampleOptions(params),
    });
    return harden({ text: response.response });
  }

  /**
   * @param params - The raw sample parameters.
   * @returns A promise resolving to a streaming result.
   */
  async #streamingSample(params: SampleParams): Promise<SampleStreamResult> {
    const ollama = await this.#makeClient();
    const response: AbortableAsyncIterator<GenerateResponse> =
      await ollama.generate({
        model: params.model,
        prompt: params.prompt,
        raw: true,
        stream: true,
        options: this.#buildSampleOptions(params),
      });
    return harden({
      stream: (async function* () {
        for await (const chunk of response) {
          yield harden(chunk);
        }
      })(),
      abort: async () => response.abort(),
    });
  }

  /**
   * @param params - The raw sample parameters.
   * @returns The options sub-object for an Ollama generate request.
   */
  #buildSampleOptions(params: SampleParams): Record<string, unknown> {
    const { temperature, seed } = params;
    let stopArr: string[] | undefined;
    if (params.stop !== undefined) {
      stopArr = Array.isArray(params.stop) ? params.stop : [params.stop];
    }
    return harden(
      ifDefined({
        temperature,
        top_p: params.top_p,
        seed,
        num_predict: params.max_tokens,
        stop: stopArr,
      }),
    );
  }

  /**
   * Creates a new language model instance with the specified configuration.
   * The returned instance is hardened for object capability security.
   *
   * @param config - The configuration for the model instance
   * @returns A promise that resolves to a hardened language model instance
   */
  async makeInstance(config: OllamaInstanceConfig): Promise<OllamaModel> {
    const modelInfo = parseModelConfig(config);
    const { model } = modelInfo;
    const ollama = await this.#makeClient();
    const defaultOptions = {
      ...(config.options ?? {}),
    };
    const mandatoryOptions = {
      model,
      stream: true as const,
      raw: true,
    };

    const instance = {
      getInfo: async () => modelInfo,
      load: async () => {
        await ollama.generate({ model, keep_alive: -1, prompt: '' });
      },
      unload: async () => {
        await ollama.generate({ model, keep_alive: 0, prompt: '' });
      },
      sample: async (prompt: string, options?: Partial<OllamaModelOptions>) => {
        const response = await ollama.generate({
          ...defaultOptions,
          ...(options ?? {}),
          ...mandatoryOptions,
          prompt,
        });
        return {
          stream: (async function* () {
            for await (const chunk of response) {
              yield chunk;
            }
          })(),
          abort: async () => response.abort(),
        };
      },
    };
    return harden(instance);
  }
}
