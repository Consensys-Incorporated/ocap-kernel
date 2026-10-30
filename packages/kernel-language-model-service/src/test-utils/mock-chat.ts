import type { ChatResult } from '../types.ts';

/**
 * A tool call the mock model makes. The `id` defaults to
 * `call-<turn>-<index>`, numbering turns from 1.
 */
export type MockToolCall = { id?: string; name: string; args: object };

/**
 * One assistant turn: the tool calls the model makes, or its final content.
 */
export type MockChatTurn = MockToolCall[] | string;

/**
 * Returns a chat function that answers each call with the next scripted turn.
 * It ignores its parameters, so it serves as a kernel service backend and as
 * an agent's bound `chat` alike.
 *
 * @param turns - The assistant turns, in order. Once they run out, the model
 * answers with empty content.
 * @returns A function matching the chat service signature.
 */
export const makeMockChat = (
  turns: MockChatTurn[],
): (() => Promise<ChatResult>) => {
  let index = 0;
  return async () => {
    const turn = turns[index] ?? '';
    index += 1;
    if (typeof turn === 'string') {
      return makeResult(index, { role: 'assistant', content: turn }, 'stop');
    }
    return makeResult(
      index,
      {
        role: 'assistant',
        content: null,
        tool_calls: turn.map(({ id, name, args }, callIndex) => ({
          id: id ?? `call-${index}-${callIndex}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
      'tool_calls',
    );
  };
};

/**
 * @param turn - The turn's ordinal, from 1.
 * @param message - The assistant message.
 * @param finishReason - Why the model stopped.
 * @returns The chat result.
 */
const makeResult = (
  turn: number,
  message: ChatResult['choices'][number]['message'],
  finishReason: ChatResult['choices'][number]['finish_reason'],
): ChatResult =>
  harden({
    id: `chat-${turn}`,
    model: 'test-model',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
