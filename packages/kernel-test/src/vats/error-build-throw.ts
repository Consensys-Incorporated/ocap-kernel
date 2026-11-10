// oxlint-disable-next-line no-console
console.log('build throw');

/**
 * Build function for vats that will throw an error during buildRootObject.
 * This function always throws and never returns.
 */
export function buildRootObject(): never {
  // oxlint-disable-next-line no-console
  console.log('buildRootObject');
  throw new Error('from buildRootObject');
}
