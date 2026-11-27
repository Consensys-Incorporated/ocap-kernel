import { ifDefined } from '../../utils.ts';

import { exampleTranscripts } from './example-transcripts.ts';
import type { ReplTranscript } from './messages.ts';
import { makeRandom } from './random.ts';

const makePreamble = (
  nTranscripts: number,
  wrapWithToken: (text: string) => string,
): string => {
  const firstLinePrefix =
    nTranscripts === 1
      ? 'The following is a transcript of a javascript REPL session environment'
      : `The following are ${nTranscripts} transcripts of javascript REPL session environments`;
  return [
    `${firstLinePrefix} controlled by a state-of-the-art capability-augmented computer assistant.`,
    `The assistant responds to user interjections by invoking capabilities to perform tasks.`,
    `The actions and observations in the transcript environment are wrapped in a line identifier, like ${wrapWithToken('> [action]')}.`,
    `Agent actions take the form of javascript statements, like ${wrapWithToken('> let x = 1;')}, ${wrapWithToken('> // I can solve this problem by...')} or ${wrapWithToken('> await search({ query: "eip-1559" });')}.`,
    `Observations are either evaluation results like ${wrapWithToken('{ "cost": 508 }')} or user interjections like ${wrapWithToken('! Merge and normalize these datasets.')} or ${wrapWithToken("! Don't schedule anything for Wednesday; I'm busy.")}.`,
    'Each transcript ends with an invocation of the end capability.',
    `Note that the assistant efficiently invokes capabilities to perform tasks. This reflects that the assistant is intelligent and can reason logically about function composition, and prefers to invoke external capabilities to prove the correctness of its answers.`,
    `Also note that, although the assistant does not necessarily use every available capability, it never attempts to use a capability that was not specified prior in the transcript.`,
  ].join('\n');
};

/**
 * The Repl Prompter pieces together repl-like representation of message,
 * wrapped in a token pair.
 * e.g.
 * ```
 * <a0b0c0>> let x = 1; </a0b0c0>
 * <a1b1c1>x: 1 </a1b1c1>
 * <a2b2c2>> x += 1; </a2b2c2>
 * <a3b3c3>x: 2 </a3b3c3>
 * <a4b4c4>> await end({ final: String(x) }); </a4b4c4>
 * ```
 *
 * @param args - The arguments to make the prompter.
 * @param args.seed - The seed to use for the random number generator.
 * @param args.tokenLength - The length of the token to use for the prompt.
 * @returns A prompter function.
 */
export const makePrompter =
  ({ seed, tokenLength = 6 }: { seed?: number; tokenLength?: number }) =>
  (
    history: ReplTranscript,
  ): {
    prompt: string;
    readerArgs: { stop: string };
  } => {
    // The random number generator is seeded with a fixed value so that the
    // same prompt is generated for the same history.
    // Language model otherwise slow.
    const random = makeRandom(ifDefined({ seed }));
    const makeTokenPair = (): [string, string] => {
      const token = random(tokenLength);
      return [`〚${token}〛`, `〚/${token}〛`];
    };
    const wrapWithToken = (text: string): string => {
      const [open, close] = makeTokenPair();
      return `${open}${text}${close}`;
    };
    const transcripts = [...exampleTranscripts, history];
    const rawPrompt = [
      makePreamble(transcripts.length, wrapWithToken),
      ...transcripts.map((transcript, index) =>
        [
          `REPL ${index + 1}:`,
          '---',
          ...transcript.map((message) => wrapWithToken(message.toReplString())),
        ].join('\n'),
      ),
    ].join('\n\n');
    const [open, stop] = makeTokenPair();
    const prompt = `${rawPrompt}\n${open}>`;
    return { prompt, readerArgs: { stop } };
  };
