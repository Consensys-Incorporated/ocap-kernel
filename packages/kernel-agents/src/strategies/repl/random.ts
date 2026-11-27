const MAX_LENGTH = 8;

/**
 * A simple seeded random number generator
 * Not cryptographically secure.
 *
 * @param a - The seed to use for the PRNG.
 * @returns A PsuedoRandomNumberGenerator.
 */
/* oxlint-disable */ // CTRL+V implementation from https://stackoverflow.com/a/47593316/1123955
const mulberry32 = (a: number): number => {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
};
/* oxlint-enable */

/**
 * Make a PsuedoRandomNumberGenerator.
 *
 * @param args - The arguments to make the PRNG.
 * @param args.seed - The seed to use for the PRNG.
 * @returns A PsuedoRandomNumberGenerator.
 */
export const makeRandom = ({ seed }: { seed?: number }) => {
  let _seed = seed ?? 1;
  return (length: number = MAX_LENGTH, radix: number = 16): string => {
    if (length > MAX_LENGTH) {
      throw new Error(`Length must be less than or equal to ${MAX_LENGTH}`);
    }
    // Get a random 32-bit unsigned integer and update the seed
    _seed = mulberry32(_seed);

    // Convert to hex and slice to desired length
    // padStart ensures we have leading zeros if needed
    return _seed.toString(radix).padStart(length, '0').slice(0, length);
  };
};
