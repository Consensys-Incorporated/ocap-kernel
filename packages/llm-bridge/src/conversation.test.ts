import { describe, expect, it, vi } from 'vitest';

import { makeConversation } from './conversation.ts';
import type { ChatMessage, OpenClawClient } from './openclaw-client.ts';

const makeClient = (
  responses: string[],
): {
  client: OpenClawClient;
  calls: ChatMessage[][];
} => {
  const calls: ChatMessage[][] = [];
  let index = 0;
  const client: OpenClawClient = {
    chat: vi.fn(async (messages: ChatMessage[]) => {
      calls.push(messages.map((message) => ({ ...message })));
      const reply = responses[index];
      index += 1;
      if (reply === undefined) {
        throw new Error(
          `mock client ran out of canned replies at call ${index}`,
        );
      }
      return reply;
    }),
  };
  return { client, calls };
};

const sampleService = (id: string) => ({
  id,
  description: `A service identified as ${id}`,
  methods: [{ name: 'doThing', description: `does the thing for ${id}` }],
});

describe('Conversation.ingest', () => {
  it('appends user/assistant pairs to the persistent history', async () => {
    const { client, calls } = makeClient(['ack-1', 'ack-2']);
    const conversation = makeConversation(client);

    await conversation.ingest({
      kind: 'ingest',
      service: sampleService('svc:0'),
    });
    await conversation.ingest({
      kind: 'ingest',
      service: sampleService('svc:1'),
    });

    // First call: system + first user message.
    expect(calls[0]?.map((message) => message.role)).toStrictEqual([
      'system',
      'user',
    ]);
    // Second call: system + first user/assistant pair + second user message.
    expect(calls[1]?.map((message) => message.role)).toStrictEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    // The persisted assistant turn carries the model's reply text.
    expect(calls[1]?.[2]?.content).toBe('ack-1');
  });

  it('formats method names and descriptions in the user turn', async () => {
    const { client, calls } = makeClient(['ack']);
    const conversation = makeConversation(client);

    await conversation.ingest({
      kind: 'ingest',
      service: sampleService('svc:9'),
    });

    const userMessage = calls[0]?.find((message) => message.role === 'user');
    expect(userMessage?.content).toContain('Register service svc:9');
    expect(userMessage?.content).toContain('A service identified as svc:9');
    expect(userMessage?.content).toContain(
      '- doThing: does the thing for svc:9',
    );
  });
});

describe('Conversation.query', () => {
  it('parses a clean JSON-array reply', async () => {
    const { client } = makeClient([
      JSON.stringify([
        { id: 'svc:0', rationale: 'best fit' },
        { id: 'svc:1', rationale: 'second' },
      ]),
    ]);
    const conversation = makeConversation(client);

    const matches = await conversation.query('something');

    expect(matches).toStrictEqual([
      { id: 'svc:0', rationale: 'best fit' },
      { id: 'svc:1', rationale: 'second' },
    ]);
  });

  it('parses a reply wrapped in a ```json code fence', async () => {
    const { client } = makeClient([
      '```json\n[{"id":"svc:0","rationale":"x"}]\n```',
    ]);
    const conversation = makeConversation(client);
    const matches = await conversation.query('q');
    expect(matches).toStrictEqual([{ id: 'svc:0', rationale: 'x' }]);
  });

  it('returns an empty list when the LLM emits []', async () => {
    const { client } = makeClient(['[]']);
    const conversation = makeConversation(client);
    expect(await conversation.query('q')).toStrictEqual([]);
  });

  it('throws when the reply is not parseable JSON', async () => {
    const { client } = makeClient(['nope']);
    const conversation = makeConversation(client);
    await expect(conversation.query('q')).rejects.toThrow(
      /not parseable JSON/u,
    );
  });

  it('throws when the reply is not a JSON array', async () => {
    const { client } = makeClient(['{"foo":"bar"}']);
    const conversation = makeConversation(client);
    await expect(conversation.query('q')).rejects.toThrow(/not a JSON array/u);
  });

  it('throws when an array entry is missing id or rationale', async () => {
    const { client } = makeClient(['[{"id":"svc:0"}]']);
    const conversation = makeConversation(client);
    await expect(conversation.query('q')).rejects.toThrow(
      /string id\/rationale/u,
    );
  });

  it('does not accumulate query traffic into the persistent history', async () => {
    const { client, calls } = makeClient(['ack', '[]', '[]']);
    const conversation = makeConversation(client);

    await conversation.ingest({
      kind: 'ingest',
      service: sampleService('svc:0'),
    });
    await conversation.query('first query');
    await conversation.query('second query');

    // Three chat calls: ingest, query, query.
    expect(calls).toHaveLength(3);
    // After the ingest, persistent history is system+user+assistant (3 turns).
    // The first query should send 4 messages (those 3 plus its ephemeral user).
    // The second query must send the same 4 — proving the first query's
    // user/assistant pair was discarded rather than carried forward.
    expect(calls[1]).toHaveLength(4);
    expect(calls[2]).toHaveLength(4);
    // And the user turn for the second query must contain "second query",
    // not "first query".
    expect(calls[2]?.[3]?.content).toContain('second query');
    expect(calls[2]?.[3]?.content).not.toContain('first query');
  });
});
