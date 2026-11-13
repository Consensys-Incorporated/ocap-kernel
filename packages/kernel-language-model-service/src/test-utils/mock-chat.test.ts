import { describe, expect, it } from 'vitest';

import { makeMockChat } from './mock-chat.ts';

describe('makeMockChat', () => {
  it('answers each call with the next turn, then with empty content', async () => {
    const chat = makeMockChat([
      [
        { name: 'add', args: { a: 1 } },
        { id: 'c2', name: 'count', args: {} },
      ],
      'done',
    ]);
    expect(await chat()).toStrictEqual({
      id: 'chat-1',
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1-0',
                type: 'function',
                function: { name: 'add', arguments: '{"a":1}' },
              },
              {
                id: 'c2',
                type: 'function',
                function: { name: 'count', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect((await chat()).choices[0]).toStrictEqual({
      index: 0,
      message: { role: 'assistant', content: 'done' },
      finish_reason: 'stop',
    });
    expect((await chat()).choices[0]?.message).toStrictEqual({
      role: 'assistant',
      content: '',
    });
  });
});
