import { describe, it, expect, vi } from 'vitest';

import {
  LANGUAGE_MODEL_SERVICE_NAME,
  makeKernelLanguageModelService,
} from './kernel-service.ts';
import type {
  ChatParams,
  ChatResult,
  SampleParams,
  SampleResult,
} from './types.ts';

const makeChatResult = (): ChatResult => ({
  id: 'chat-1',
  model: 'test-model',
  choices: [
    {
      message: { role: 'assistant', content: 'hi' },
      index: 0,
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const makeSampleResult = (): SampleResult => ({ text: 'hello' });

describe('LANGUAGE_MODEL_SERVICE_NAME', () => {
  it('equals languageModelService', () => {
    expect(LANGUAGE_MODEL_SERVICE_NAME).toBe('languageModelService');
  });
});

describe('makeKernelLanguageModelService', () => {
  it('returns object with correct name and a service', () => {
    const chat = vi.fn();
    const result = makeKernelLanguageModelService(chat);
    expect(result).toMatchObject({
      name: LANGUAGE_MODEL_SERVICE_NAME,
      service: expect.any(Object),
    });
  });

  it('service has chat and sample methods', () => {
    const chat = vi.fn();
    const { service } = makeKernelLanguageModelService(chat);
    expect(service).toMatchObject({
      chat: expect.any(Function),
      sample: expect.any(Function),
    });
  });

  it('chat delegates to underlying function and returns hardened result', async () => {
    const chatResult = makeChatResult();
    const chat = vi.fn().mockResolvedValue(chatResult);
    const { service } = makeKernelLanguageModelService(chat);

    const params: ChatParams = {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = await (
      service as { chat: (params: ChatParams) => Promise<ChatResult> }
    ).chat(params);

    expect(chat).toHaveBeenCalledWith(params);
    expect(result).toStrictEqual(chatResult);
  });

  it('sample delegates to provided function and returns hardened result', async () => {
    const rawResult = makeSampleResult();
    const chat = vi.fn();
    const sample = vi.fn().mockResolvedValue(rawResult);
    const { service } = makeKernelLanguageModelService(chat, sample);

    const params: SampleParams = { model: 'test', prompt: 'hello' };
    const result = await (
      service as {
        sample: (params: SampleParams) => Promise<SampleResult>;
      }
    ).sample(params);

    expect(sample).toHaveBeenCalledWith(params);
    expect(result).toStrictEqual(rawResult);
  });

  it('sample throws when no sample function provided', async () => {
    const chat = vi.fn();
    const { service } = makeKernelLanguageModelService(chat);

    await expect(
      (
        service as {
          sample: (params: SampleParams) => Promise<SampleResult>;
        }
      ).sample({ model: 'test', prompt: 'hello' }),
    ).rejects.toThrow('raw sampling not supported by this backend');
  });
});
