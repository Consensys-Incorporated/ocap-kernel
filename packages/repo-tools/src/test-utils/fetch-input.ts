/**
 * A CWE-367 primitive: an input whose stringifier names one host when an
 * allowlist reads it and another when `fetch` does. Pass the same value twice
 * for a stringifier that is merely unusual rather than hostile.
 *
 * @param first - Reported on the first read.
 * @param rest - Reported on every read thereafter.
 * @returns The input, and a count of the reads its stringifier has served.
 */
export const makeTwoFacedFetchInput = (
  first: string,
  rest: string,
): { input: Parameters<typeof fetch>[0]; getReads: () => number } => {
  let reads = 0;
  const input = {
    toString: () => {
      reads += 1;
      return reads === 1 ? first : rest;
    },
  };
  return {
    input: input as unknown as Parameters<typeof fetch>[0],
    getReads: () => reads,
  };
};
