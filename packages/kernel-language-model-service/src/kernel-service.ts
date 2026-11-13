import type {
  ChatParams,
  ChatResult,
  SampleParams,
  SampleResult,
} from './types.ts';

/**
 * Canonical service name for the language model service in `ClusterConfig.services`.
 */
export const LANGUAGE_MODEL_SERVICE_NAME = 'languageModelService';

/**
 * Backend functions wrapped by {@link makeKernelLanguageModelService}.
 */
export type KernelLanguageModelServiceOptions = {
  /** Performs a chat completion request. */
  chat: (params: ChatParams & { stream?: true & false }) => Promise<ChatResult>;
  /**
   * Performs a raw token-prediction request. If omitted, `service.sample()`
   * throws "raw sampling not supported by this backend".
   */
  sample?: (params: SampleParams) => Promise<SampleResult>;
};

/**
 * Throw if a request asks for a stream. A backend's stream is an async
 * iterable, which cannot be passed across the kernel marshal boundary.
 *
 * @param method - The service method, for the error message.
 * @param params - The request parameters.
 */
const assertNotStreaming = (method: string, params: object): void => {
  if ((params as { stream?: unknown }).stream === true) {
    throw new Error(
      `languageModelService.${method} does not support stream: true`,
    );
  }
};

/**
 * Wraps `chat` and optional `sample` functions into a flat, stateless kernel service object.
 * Use the returned `{ name, service }` with `kernel.registerKernelServiceObject(name, service)`.
 *
 * Return values are plain hardened data — no exos — so they are safely serializable
 * across the kernel marshal boundary. For the same reason, requests with
 * `stream: true` are rejected.
 *
 * @param options - The backend functions.
 * @param options.chat - Performs a chat completion request.
 * @param options.sample - Performs a raw token-prediction request.
 * @returns An object with `name` and `service` fields for use with the kernel.
 */
export const makeKernelLanguageModelService = ({
  chat,
  sample,
}: KernelLanguageModelServiceOptions): { name: string; service: object } => {
  const service = harden({
    async chat(params: ChatParams): Promise<ChatResult> {
      assertNotStreaming('chat', params);
      return harden(await chat(params as ChatParams & { stream?: never }));
    },
    async sample(params: SampleParams): Promise<SampleResult> {
      if (!sample) {
        throw new Error('raw sampling not supported by this backend');
      }
      assertNotStreaming('sample', params);
      return harden(await sample(params));
    },
  });
  return harden({ name: LANGUAGE_MODEL_SERVICE_NAME, service });
};
