import { describe, it, expect, vi } from 'vitest';

import { makeChatClient, makeSampleClient } from './client.ts';
import type { ChatResult, SampleResult } from './types.ts';

const MODEL = 'glm-4.7-flash';

vi.mock('@endo/eventual-send', () => ({
  E: vi.fn((obj: unknown) => obj),
}));

const makeChatResult = (): ChatResult => ({
  id: 'chat-1',
  model: MODEL,
  choices: [
    {
      message: { role: 'assistant', content: 'hello' },
      index: 0,
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const makeSampleResult = (): SampleResult => ({ text: 'hi there' });

describe('makeChatClient', () => {
  it('calls chat on the lmsRef with merged model', async () => {
    const chatResult = makeChatResult();
    const lmsRef = { chat: vi.fn().mockResolvedValue(chatResult) };

    const client = makeChatClient(lmsRef, MODEL);
    const result = await client.chat.completions.create({
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(lmsRef.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: MODEL,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
    expect(result).toStrictEqual(chatResult);
  });

  it('params.model overrides defaultModel', async () => {
    const lmsRef = { chat: vi.fn().mockResolvedValue(makeChatResult()) };
    const client = makeChatClient(lmsRef, 'gpt-3.5');

    await client.chat.completions.create({
      messages: [{ role: 'user', content: 'hi' }],
      model: MODEL,
    });

    expect(lmsRef.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: MODEL }),
    );
  });

  it('throws when no model is available', async () => {
    const lmsRef = { chat: vi.fn() };
    const client = makeChatClient(lmsRef);

    await expect(
      client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('model is required');
  });
});

describe('makeSampleClient', () => {
  it('calls sample on the lmsRef with merged model', async () => {
    const rawResult = makeSampleResult();
    const lmsRef = { sample: vi.fn().mockResolvedValue(rawResult) };

    const client = makeSampleClient(lmsRef, 'llama3');
    const result = await client.sample({ prompt: 'Once upon' });

    expect(lmsRef.sample).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'llama3', prompt: 'Once upon' }),
    );
    expect(result).toStrictEqual(rawResult);
  });

  it('params.model overrides defaultModel', async () => {
    const lmsRef = {
      sample: vi.fn().mockResolvedValue(makeSampleResult()),
    };
    const client = makeSampleClient(lmsRef, 'llama3');

    await client.sample({ prompt: 'hi', model: 'mistral' });

    expect(lmsRef.sample).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mistral' }),
    );
  });

  it('throws when no model is available', async () => {
    const lmsRef = { sample: vi.fn() };
    const client = makeSampleClient(lmsRef);

    await expect(client.sample({ prompt: 'hi' })).rejects.toThrow(
      'model is required',
    );
  });
});
