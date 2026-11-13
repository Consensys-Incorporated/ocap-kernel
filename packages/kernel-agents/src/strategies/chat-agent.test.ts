import '@ocap/repo-tools/test-utils/mock-endoify';

import { S } from '@metamask/kernel-utils';
import type { ChatMessage } from '@metamask/kernel-language-model-service';
import { makeMockChat } from '@metamask/kernel-language-model-service/test-utils';
import type { MockChatTurn } from '@metamask/kernel-language-model-service/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { makeChatAgent } from './chat-agent.ts';
import type { BoundChat } from './chat-agent.ts';
import { makeMethodCapability } from '../../test/make-method-capability.ts';

/**
 * A scripted chat that records the messages of each call.
 *
 * @param turns - The assistant turns, in order.
 * @returns The chat and the record.
 */
const makeRecordingChat = (
  turns: MockChatTurn[],
): { chat: BoundChat; recorded: ChatMessage[][] } => {
  const mockChat = makeMockChat(turns);
  const recorded: ChatMessage[][] = [];
  return {
    chat: async ({ messages }) => {
      recorded.push([...messages]);
      return mockChat();
    },
    recorded,
  };
};

const makeAdd = () => {
  const add = vi.fn(async (a: number, b: number) => a + b);
  const capability = makeMethodCapability(
    'Math',
    'add',
    add,
    S.method(
      'Add two numbers',
      [S.arg('a', S.number()), S.arg('b', S.number())],
      S.number(),
    ),
  );
  return { add, capability };
};

const ping = makeMethodCapability(
  'Server',
  'ping',
  async () => 'pong',
  S.method('Ping the server', [], S.string()),
);

const noCapabilities = {};

describe('makeChatAgent', () => {
  it('returns plain text response when model does not invoke a tool', async () => {
    const chat = makeMockChat(['Hello, world!']);
    const agent = makeChatAgent({ chat, capabilities: noCapabilities });

    const result = await agent.task('say hello');
    expect(result).toBe('Hello, world!');
  });

  it('dispatches a tool call and returns final text answer', async () => {
    const { add, capability } = makeAdd();
    const chat = makeMockChat([[{ name: 'add', args: { a: 3, b: 4 } }], '7']);

    const agent = makeChatAgent({ chat, capabilities: { add: capability } });

    const result = await agent.task('add 3 and 4');
    expect(add).toHaveBeenCalledWith(3, 4);
    expect(result).toBe('7');
  });

  it('injects tool result message before next turn', async () => {
    const { chat, recorded } = makeRecordingChat([
      [{ id: 'c1', name: 'ping', args: {} }],
      'done',
    ]);

    const agent = makeChatAgent({ chat, capabilities: { ping } });
    await agent.task('ping');

    // Second turn must include the tool result message
    const secondTurn = recorded[1] ?? [];
    expect(
      secondTurn.some(
        (message) => message.role === 'tool' && message.tool_call_id === 'c1',
      ),
    ).toBe(true);
    expect(secondTurn.some((message) => message.content === '"pong"')).toBe(
      true,
    );
  });

  it('injects error message for unknown tool and continues', async () => {
    const { chat, recorded } = makeRecordingChat([
      [{ name: 'nonexistent', args: {} }],
      'recovered',
    ]);

    const agent = makeChatAgent({ chat, capabilities: noCapabilities });
    const result = await agent.task('do something');

    expect(result).toBe('recovered');
    const secondTurn = recorded[1] ?? [];
    expect(
      secondTurn.some(
        (message) =>
          message.role === 'tool' &&
          message.content.includes('Unknown capability'),
      ),
    ).toBe(true);
  });

  it('injects a tool error for an invalid-argument tool call and continues', async () => {
    const { add, capability } = makeAdd();
    const { chat, recorded } = makeRecordingChat([
      // `b` is missing, so the exo's interface guard rejects the call.
      [{ name: 'add', args: { a: 3 } }],
      'recovered',
    ]);

    const agent = makeChatAgent({ chat, capabilities: { add: capability } });
    const result = await agent.task('add 3 and ?');

    // The guard rejection surfaces as a tool error rather than crashing the
    // task, and the implementation never runs with the bad arguments.
    expect(result).toBe('recovered');
    expect(add).not.toHaveBeenCalled();
    const secondTurn = recorded[1] ?? [];
    // The membrane normalizes the rejection into a real error carrying the
    // expected signature, so the message is actionable even when the guard
    // itself rejects with an opaque value (as it does under the test shim).
    expect(
      secondTurn.some(
        (message) =>
          message.role === 'tool' &&
          message.content.startsWith(
            'Error calling add(a: number, b: number):',
          ),
      ),
    ).toBe(true);
  });

  it('throws when invocation budget is exceeded', async () => {
    const chat = makeMockChat(
      Array.from({ length: 3 }, () => [{ name: 'ping', args: {} }]),
    );

    const agent = makeChatAgent({ chat, capabilities: { ping } });

    await expect(
      agent.task('go', undefined, { invocationBudget: 3 }),
    ).rejects.toThrow('Invocation budget exceeded');
  });

  it('applies judgment to final answer', async () => {
    const chat = makeMockChat(['hello']);
    const agent = makeChatAgent({ chat, capabilities: noCapabilities });

    const isNumber = (result: unknown): result is number =>
      typeof result === 'number';
    await expect(agent.task('go', isNumber)).rejects.toThrow('Invalid result');
  });

  it('passes tools to the chat function', async () => {
    const recordedTools: unknown[] = [];
    const mockChat = makeMockChat(['done']);
    const chat: BoundChat = async ({ tools }) => {
      recordedTools.push(tools);
      return mockChat();
    };

    const agent = makeChatAgent({ chat, capabilities: { ping } });
    await agent.task('go');

    expect(recordedTools[0]).toStrictEqual([
      {
        type: 'function',
        function: {
          name: 'ping',
          description: 'Ping the server',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ]);
  });

  it('passes undefined tools when there are no capabilities', async () => {
    let recordedTools: unknown = 'not-set';
    const mockChat = makeMockChat(['done']);
    const chat: BoundChat = async ({ tools }) => {
      recordedTools = tools;
      return mockChat();
    };

    const agent = makeChatAgent({ chat, capabilities: noCapabilities });
    await agent.task('go');

    expect(recordedTools).toBeUndefined();
  });

  it('accumulates experiences across tasks', async () => {
    const chat = makeMockChat(['hello', 'world']);
    const agent = makeChatAgent({ chat, capabilities: noCapabilities });

    await agent.task('first');
    await agent.task('second');

    const exps = [];
    for await (const exp of agent.experiences) {
      exps.push(exp);
    }
    expect(exps).toHaveLength(2);
    expect(exps[0]?.objective.intent).toBe('first');
    expect(exps[1]?.objective.intent).toBe('second');
  });
});
