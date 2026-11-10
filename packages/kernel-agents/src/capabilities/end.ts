import { S } from '@metamask/kernel-utils';

import { makeInternalCapabilities } from './discover.ts';
import { ifDefined } from '../utils.ts';

/**
 * A factory function to make a task's `end` capability, which stores the first
 * invocation as the final result and ignores all subsequent invocations.
 *
 * @template Result - The expected type of the final result.
 * @returns A tuple containing the end capability, a function to check if the end capability was invoked, and a function to get the final result.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const makeEnd = <Result>() => {
  // Captured, mutable state for the first final result. Intentionally NOT
  // hardened: the exo method below closes over and mutates it.
  const result: { final?: Result; attachments?: Record<string, unknown> } = {};

  const { end } = makeInternalCapabilities(
    'End',
    {
      async end(
        final: Result,
        attachments?: Record<string, unknown>,
      ): Promise<void> {
        if (!Object.hasOwn(result, 'final')) {
          Object.assign(result, { final, ...ifDefined({ attachments }) });
        }
      },
    },
    S.interface('End', {
      end: S.method(
        'Return a final response to the user.',
        [
          S.arg(
            'final',
            S.string(
              'A concise final response that restates the requested information.',
            ),
          ),
          S.arg('attachments', S.record('Attachments to the final response.'), {
            optional: true,
          }),
        ],
        S.nothing(),
      ),
    }),
  );

  return [end, () => 'final' in result, () => result.final as Result] as const;
};

/**
 * A default `end` capability that does nothing.
 */
export const [end] = makeEnd();
