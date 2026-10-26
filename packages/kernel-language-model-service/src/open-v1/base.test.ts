import { StructError } from '@metamask/superstruct';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatResult, ChatStreamChunk } from '../types.ts';
import { OpenV1BaseService } from './base.ts';
import { normalizeStreamChunk } from './normalize-stream-chunk.ts';
import type {
  ChatStreamChunkWire,
  ChatStreamDeltaWire,
} from './normalize-stream-chunk.ts';

const MODEL = 'glm-4.7-flash';

const makeChatResult = (): ChatResult => ({
  id: 'chat-1',
  model: MODEL,
  choices: [
    {
      message: { role: 'assistant', content: 'hi there' },
      index: 0,
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const makeOkResponse = (init: {
  text?: () => Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    ...init,
  }) as Response;

const makeMockFetch = (payload: unknown): typeof globalThis.fetch =>
  vi.fn().mockResolvedValue(
    makeOkResponse({
      text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    }),
  );

const makeSSEStream = (
  chunks: ChatStreamChunkWire[],
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const lines = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('');
  const body = `${lines}data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
};

const makeWireStreamChunk = (
  delta: ChatStreamDeltaWire,
): ChatStreamChunkWire => ({
  id: 'chat-1',
  model: MODEL,
  choices: [{ delta, index: 0, finish_reason: null }],
});

const makeStreamChunk = (content: string): ChatStreamChunkWire =>
  makeWireStreamChunk({ content });

const makeMockStreamFetch = (
  chunks: ChatStreamChunkWire[],
): typeof globalThis.fetch =>
  vi.fn().mockResolvedValue(makeOkResponse({ body: makeSSEStream(chunks) }));

describe('OpenV1BaseService', () => {
  let service: OpenV1BaseService;
  let mockFetch: ReturnType<typeof makeMockFetch>;

  beforeEach(() => {
    mockFetch = makeMockFetch(makeChatResult());
    service = new OpenV1BaseService(
      mockFetch,
      'http://localhost:11434',
      'sk-test',
    );
  });

  describe('chat', () => {
    it('posts to /v1/chat/completions with serialized params', async () => {
      const params = {
        model: MODEL,
        messages: [{ role: 'user' as const, content: 'hello' }],
      };
      await service.chat(params);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ...params, stream: false }),
        }),
      );
    });

    it('sends stream: false when stream is not set', async () => {
      await service.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({ stream: false });
    });

    it('includes Authorization header when apiKey is set', async () => {
      await service.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-test',
      );
    });

    it('omits Authorization header when no apiKey', async () => {
      const noKeyFetch = makeMockFetch(makeChatResult());
      const noKeyService = new OpenV1BaseService(
        noKeyFetch,
        'http://localhost:11434',
      );
      await noKeyService.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const [, init] = (noKeyFetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      expect(
        (init.headers as Record<string, string>).Authorization,
      ).toBeUndefined();
    });

    it('returns the parsed JSON response', async () => {
      const expected = makeChatResult();
      mockFetch = makeMockFetch(expected);
      service = new OpenV1BaseService(mockFetch, 'http://localhost:11434');

      const result = await service.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(result).toStrictEqual(expected);
    });

    it('throws on invalid params (empty model)', () => {
      expect(() => {
        // oxlint-disable-next-line no-void
        void service.chat({
          model: '',
          messages: [{ role: 'user', content: 'hi' }],
        });
      }).toThrow('Expected a string with a length between');
    });

    it('throws on invalid params (invalid role)', () => {
      expect(() => {
        // oxlint-disable-next-line no-void
        void service.chat({
          model: MODEL,
          messages: [{ role: 'unknown' as never, content: 'hi' }],
        });
      }).toThrow('Expected the value to satisfy a union');
    });

    it('uses custom baseUrl', async () => {
      const customFetch = makeMockFetch(makeChatResult());
      const customService = new OpenV1BaseService(
        customFetch,
        'https://my-llm.internal',
      );
      await customService.chat({
        model: 'my-model',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(customFetch).toHaveBeenCalledWith(
        'https://my-llm.internal/v1/chat/completions',
        expect.any(Object),
      );
    });

    it('throws a clear error when the HTTP status is not ok', async () => {
      const errFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: vi.fn().mockResolvedValue('{"error":"rate_limited"}'),
      } as unknown as Response);
      const errService = new OpenV1BaseService(
        errFetch,
        'http://localhost:8080',
      );

      await expect(
        errService.chat({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow(
        'HTTP 429 Too Many Requests — {"error":"rate_limited"}',
      );
    });

    it('throws when the response body is not valid JSON', async () => {
      const badJsonFetch = vi.fn().mockResolvedValue(
        makeOkResponse({
          text: vi.fn().mockResolvedValue('not-json'),
        }),
      );
      const badService = new OpenV1BaseService(
        badJsonFetch,
        'http://localhost:8080',
      );

      await expect(
        badService.chat({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow(SyntaxError);
    });
  });

  describe('listModels', () => {
    it('gets /v1/models and returns model IDs', async () => {
      const modelsFetch = makeMockFetch({
        data: [{ id: 'model-a' }, { id: 'model-b' }],
      });
      const modelsService = new OpenV1BaseService(
        modelsFetch,
        'http://localhost:8080',
        'sk-test',
      );

      const result = await modelsService.listModels();

      expect(modelsFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/models',
        expect.any(Object),
      );
      expect(result).toStrictEqual(['model-a', 'model-b']);
    });

    it('includes Authorization header when apiKey is set', async () => {
      const modelsFetch = makeMockFetch({ data: [{ id: 'model-a' }] });
      const modelsService = new OpenV1BaseService(
        modelsFetch,
        'http://localhost:8080',
        'sk-key',
      );

      await modelsService.listModels();

      const [, init] = (modelsFetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-key',
      );
    });

    it('throws a clear error when the HTTP status is not ok', async () => {
      const errFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: vi.fn().mockResolvedValue('invalid key'),
      } as unknown as Response);
      const errService = new OpenV1BaseService(
        errFetch,
        'http://localhost:8080',
      );

      await expect(errService.listModels()).rejects.toThrow(
        'HTTP 401 Unauthorized — invalid key',
      );
    });
  });

  describe('chat with stream: true', () => {
    it('posts to /v1/chat/completions with stream: true in body', async () => {
      const streamFetch = makeMockStreamFetch([makeStreamChunk('hi')]);
      const streamService = new OpenV1BaseService(
        streamFetch,
        'http://localhost:11434',
      );
      // oxlint-disable-next-line typescript/no-unused-vars
      for await (const _ of streamService.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) {
        // drain
      }

      expect(streamFetch).toHaveBeenCalledWith(
        'http://localhost:11434/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        }),
      );
    });

    it('yields parsed chunks and stops at [DONE]', async () => {
      const wire = [makeStreamChunk('Hello'), makeStreamChunk(', world!')];
      const expected = wire.map((chunk) => normalizeStreamChunk(chunk));
      const streamFetch = makeMockStreamFetch(wire);
      const streamService = new OpenV1BaseService(
        streamFetch,
        'http://localhost:11434',
      );

      const received: ChatStreamChunk[] = [];
      for await (const chunk of streamService.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) {
        received.push(chunk);
      }

      expect(received).toStrictEqual(expected);
    });

    it('accepts streaming delta with assistant role and tool_calls fragments', async () => {
      const wireTool = makeWireStreamChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'fn' },
          },
        ],
      });
      const streamFetch = makeMockStreamFetch([wireTool]);
      const streamService = new OpenV1BaseService(
        streamFetch,
        'http://localhost:11434',
      );

      const received: ChatStreamChunk[] = [];
      for await (const chunk of streamService.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) {
        received.push(chunk);
      }

      expect(received).toStrictEqual([normalizeStreamChunk(wireTool)]);
    });

    it('rejects streaming chunk when delta role is not assistant', async () => {
      const badChunk: ChatStreamChunkWire = {
        id: 'chat-1',
        model: MODEL,
        choices: [
          {
            delta: {
              role: 'user',
              content: 'x',
            } as unknown as ChatStreamDeltaWire,
            index: 0,
            finish_reason: null,
          },
        ],
      };
      const streamFetch = makeMockStreamFetch([badChunk]);
      const streamService = new OpenV1BaseService(
        streamFetch,
        'http://localhost:11434',
      );

      await expect(async () => {
        // oxlint-disable-next-line typescript/no-unused-vars
        for await (const _ of streamService.chat({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })) {
          // drain
        }
      }).rejects.toSatisfy((rejection: unknown) => {
        if (!(rejection instanceof Error)) {
          return false;
        }
        if (!rejection.message.startsWith('Error parsing JSON: ')) {
          return false;
        }
        return rejection.cause instanceof StructError;
      });
    });

    it('throws when response body is null', async () => {
      const nullBodyFetch: typeof globalThis.fetch = vi
        .fn()
        .mockResolvedValue(makeOkResponse({ body: null }));
      const streamService = new OpenV1BaseService(
        nullBodyFetch,
        'http://localhost:11434',
      );

      await expect(async () => {
        // oxlint-disable-next-line typescript/no-unused-vars
        for await (const _ of streamService.chat({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })) {
          // drain
        }
      }).rejects.toThrow('No response body for streaming');
    });

    it('throws a clear error when the HTTP status is not ok before reading the stream', async () => {
      const errFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('upstream failure'),
        body: makeSSEStream([makeStreamChunk('x')]),
      } as unknown as Response);
      const errService = new OpenV1BaseService(
        errFetch,
        'http://localhost:11434',
      );

      await expect(async () => {
        // oxlint-disable-next-line typescript/no-unused-vars
        for await (const _ of errService.chat({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })) {
          // drain
        }
      }).rejects.toThrow('HTTP 500 Internal Server Error — upstream failure');
    });

    it('throws a descriptive error when an SSE data line is not valid JSON', async () => {
      const encoder = new TextEncoder();
      const badBody = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: not-json\n\n'));
          controller.close();
        },
      });
      const badFetch = vi
        .fn()
        .mockResolvedValue(makeOkResponse({ body: badBody }));
      const badService = new OpenV1BaseService(
        badFetch,
        'http://localhost:11434',
      );

      await expect(async () => {
        // oxlint-disable-next-line typescript/no-unused-vars
        for await (const _ of badService.chat({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })) {
          // drain
        }
      }).rejects.toSatisfy((rejection: unknown) => {
        if (!(rejection instanceof Error)) {
          return false;
        }
        if (rejection.message !== 'Error parsing JSON: not-json') {
          return false;
        }
        return rejection.cause instanceof SyntaxError;
      });
    });
  });
});
