/**
 * Thin HTTP client for openclaw's OpenAI-compatible
 * `POST /v1/chat/completions` endpoint. We don't pull in the OpenAI
 * SDK or any provider SDK because the gateway already abstracts that
 * away — it just speaks the OpenAI wire shape, and our needs are tiny.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type OpenClawClientConfig = {
  /** Base URL of the openclaw gateway, e.g. `http://127.0.0.1:18789`. */
  baseUrl: string;
  /** Bearer token matching `gateway.auth.token` in the gateway config. */
  token: string;
  /**
   * `model` value to send. Per openclaw's docs this is treated as an
   * "agent target," not a raw provider model id: `openclaw` resolves
   * to the configured default agent; `openclaw/<agentId>` pins a
   * specific one.
   */
  model: string;
  /**
   * Optional logger. When set, the client emits one
   * "→ chat-completions request" line and one "← chat-completions reply"
   * line per call, each containing the corresponding JSON-encoded body.
   * Default: silent.
   */
  log?: (message: string) => void;
};

export type OpenClawClient = {
  /**
   * POST the supplied messages to chat/completions and return the
   * assistant's textual reply. Throws on non-2xx responses or unexpected
   * payload shapes.
   *
   * @param messages - The full chat history to send.
   * @returns The assistant's reply text.
   */
  chat(messages: ChatMessage[]): Promise<string>;
};

type ChatCompletionsResponse = {
  choices?: { message?: { content?: unknown } }[];
};

/**
 * Build an {@link OpenClawClient} bound to a particular gateway.
 *
 * @param config - Gateway URL, bearer token, and agent model.
 * @returns A client with a single `chat()` method.
 */
export function makeOpenClawClient(
  config: OpenClawClientConfig,
): OpenClawClient {
  const url = `${config.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`;
  const log = config.log ?? ((): void => undefined);
  return {
    async chat(messages: ChatMessage[]): Promise<string> {
      const requestBody = { model: config.model, messages };
      log(`→ chat-completions request: ${JSON.stringify(requestBody)}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log(`← chat-completions error HTTP ${response.status}: ${body}`);
        throw new Error(
          `openclaw gateway returned HTTP ${response.status}: ${body}`,
        );
      }
      const parsed = (await response.json()) as ChatCompletionsResponse;
      log(`← chat-completions reply: ${JSON.stringify(parsed)}`);
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(
          `openclaw response missing choices[0].message.content: ${JSON.stringify(parsed)}`,
        );
      }
      return content;
    },
  };
}
