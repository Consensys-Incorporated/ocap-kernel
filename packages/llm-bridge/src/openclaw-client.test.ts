import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeOpenClawClient } from './openclaw-client.ts';

describe('makeOpenClawClient.chat', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const okResponse = (content: string): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('posts to /v1/chat/completions on the base URL', async () => {
    fetchSpy.mockResolvedValue(okResponse('hi'));
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789',
      token: 'tok',
      model: 'openclaw',
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://example.test:18789/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer tok',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('strips a trailing slash from baseUrl when constructing the URL', async () => {
    fetchSpy.mockResolvedValue(okResponse('hi'));
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789/',
      token: 'tok',
      model: 'openclaw',
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://example.test:18789/v1/chat/completions',
      expect.anything(),
    );
  });

  it('returns choices[0].message.content from the response body', async () => {
    fetchSpy.mockResolvedValue(okResponse('the reply'));
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789',
      token: 'tok',
      model: 'openclaw',
    });
    expect(await client.chat([{ role: 'user', content: 'q' }])).toBe(
      'the reply',
    );
  });

  it('throws when the gateway responds non-2xx', async () => {
    fetchSpy.mockResolvedValue(new Response('forbidden', { status: 401 }));
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789',
      token: 'tok',
      model: 'openclaw',
    });
    await expect(client.chat([{ role: 'user', content: 'q' }])).rejects.toThrow(
      /HTTP 401: forbidden/u,
    );
  });

  it('throws when the response body has no choices[0].message.content', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789',
      token: 'tok',
      model: 'openclaw',
    });
    await expect(client.chat([{ role: 'user', content: 'q' }])).rejects.toThrow(
      /missing choices\[0\]\.message\.content/u,
    );
  });

  it('logs the request body and the parsed response when a logger is supplied', async () => {
    fetchSpy.mockResolvedValue(okResponse('hello back'));
    const lines: string[] = [];
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789',
      token: 'tok',
      model: 'openclaw',
      log: (line: string) => lines.push(line),
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    const requestLine = lines.find((line) =>
      line.startsWith('→ chat-completions request:'),
    );
    const replyLine = lines.find((line) =>
      line.startsWith('← chat-completions reply:'),
    );
    expect(requestLine).toBeDefined();
    expect(requestLine).toContain('"role":"user"');
    expect(requestLine).toContain('"content":"hi"');
    expect(replyLine).toBeDefined();
    expect(replyLine).toContain('"content":"hello back"');
  });

  it('logs an error line on non-2xx responses', async () => {
    fetchSpy.mockResolvedValue(new Response('forbidden', { status: 401 }));
    const lines: string[] = [];
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789',
      token: 'tok',
      model: 'openclaw',
      log: (line: string) => lines.push(line),
    });

    await expect(client.chat([{ role: 'user', content: 'q' }])).rejects.toThrow(
      /HTTP 401/u,
    );
    expect(
      lines.some((line) =>
        line.startsWith('← chat-completions error HTTP 401'),
      ),
    ).toBe(true);
  });

  it('sends the configured model and the supplied messages in the request body', async () => {
    fetchSpy.mockResolvedValue(okResponse('ok'));
    const client = makeOpenClawClient({
      baseUrl: 'http://example.test:18789',
      token: 'tok',
      model: 'openclaw/custom-agent',
    });

    await client.chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ]);

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body).toStrictEqual({
      model: 'openclaw/custom-agent',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u' },
      ],
    });
  });
});
