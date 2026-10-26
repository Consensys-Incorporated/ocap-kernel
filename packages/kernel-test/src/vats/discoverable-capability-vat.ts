import { makeDiscoverableExo } from '@metamask/kernel-utils/discoverable';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * Build function for a vat that exports a discoverable exo capability.
 *
 * @param _vatPowers - Special powers granted to this vat (not used here).
 * @param _parameters - Initialization parameters from the vat's config object.
 * @param _baggage - Root of vat's persistent state (not used here).
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  _vatPowers: unknown,
  _parameters: unknown = {},
  _baggage: unknown = null,
) {
  const calculator = makeDiscoverableExo(
    'Calculator',
    {
      add: (a: number, b: number) => a + b,
      multiply: (a: number, b: number) => a * b,
      greet: (name: string) => `Hello, ${name}!`,
    },
    {
      add: {
        description: 'Adds two numbers together',
        args: {
          a: {
            type: 'number',
            description: 'First number',
          },
          b: {
            type: 'number',
            description: 'Second number',
          },
        },
        returns: {
          type: 'number',
          description: 'The sum of the two numbers',
        },
      },
      multiply: {
        description: 'Multiplies two numbers together',
        args: {
          a: {
            type: 'number',
            description: 'First number',
          },
          b: {
            type: 'number',
            description: 'Second number',
          },
        },
        returns: {
          type: 'number',
          description: 'The product of the two numbers',
        },
      },
      greet: {
        description: 'Greets a person by name',
        args: {
          name: {
            type: 'string',
            description: 'The name of the person to greet',
          },
        },
        returns: {
          type: 'string',
          description: 'A greeting message',
        },
      },
    },
  );

  return makeDefaultExo('root', {
    bootstrap() {
      return 'discoverable-capability-vat ready';
    },
    getCalculator() {
      return calculator;
    },
  });
}
