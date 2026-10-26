import { makeDiscoverableExo } from '@metamask/kernel-utils/discoverable';

export const ECHO_SERVICE_DESCRIPTION =
  'Echoes back whatever text it is given, optionally reversed. Useful for testing connectivity and round-trip latency.';

/**
 * Build a trivial Echo service exo. Used during development to give the
 * service matcher at least one meaningful alternative to rank alongside
 * the real wallet service.
 *
 * @returns A discoverable exo with an `echo` method.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function makeEchoService() {
  return makeDiscoverableExo(
    'EchoService',
    {
      async echo(message: string, reverse: boolean = false): Promise<string> {
        if (reverse) {
          // Use Array.from so multi-code-point characters (e.g., emoji)
          // survive the reversal intact.
          return Array.from(message).reverse().join('');
        }
        return message;
      },
    },
    {
      echo: {
        description:
          'Return the input message, optionally reversed end-for-end.',
        args: {
          message: {
            type: 'string',
            description: 'Any text.',
          },
          reverse: {
            type: 'boolean',
            description:
              'If true, the returned string is the input reversed character by character. Defaults to false.',
          },
        },
        returns: {
          type: 'string',
          description:
            'The input text, returned unchanged when `reverse` is false (or omitted) and reversed when `reverse` is true.',
        },
      },
    },
  );
}
