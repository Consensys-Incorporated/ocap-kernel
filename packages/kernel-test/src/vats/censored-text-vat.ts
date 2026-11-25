import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * A vat whose source holds text that SES rejects outside code, so that it
 * starts only if the bundler rewrote that text.
 *
 * @returns The root object for this vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  return makeDefaultExo('root', {
    bootstrap() {
      return [
        'Trailing comma is not allowed in import()',
        `see import(x)`,
        '<!-- x',
        'x -->',
      ];
    },
  });
}
