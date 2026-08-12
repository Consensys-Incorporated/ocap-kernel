import { delay } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';

type GCFunction = () => void;

/**
 * Try to get a GC function for the current environment
 *
 * @param logger - The logger to use.
 * @returns A function that triggers GC and finalization when possible
 */
async function getGCFunction(logger?: Logger): Promise<GCFunction | undefined> {
  if (typeof globalThis.gc === 'function') {
    return globalThis.gc as GCFunction;
  }

  // Check if we're in Node.js
  if (
    typeof globalThis === 'object' &&
    Object.prototype.toString.call(globalThis.process) === '[object process]'
  ) {
    try {
      // Dynamic import of Node.js specific module so it's not included in browser builds
      const { engineGC } = await import('./gc-engine.ts');
      return engineGC as GCFunction;
    } catch (error) {
      logger?.debug('Failed to load Node.js GC implementation:', error);
    }
  }

  return undefined;
}

/**
 * Utility to create a function that performs garbage collection and finalization
 * in a cross-environment compatible way.
 *
 * @param logger - The logger to use.
 * @returns A function that triggers GC and finalization when possible
 */
export function makeGCAndFinalize(logger?: Logger): () => Promise<void> {
  // Cache the GC function promise
  const gcFunctionPromise = getGCFunction(logger);

  /**
   * Function to trigger garbage collection and finalization
   */
  return async function gcAndFinalize(): Promise<void> {
    try {
      const gcFunction = await gcFunctionPromise;

      if (gcFunction) {
        // Drain the queues *before* collecting. A pending continuation still
        // holds its closure's objects, so a sweep run with work outstanding
        // finds them reachable and drops nothing — which is the difference
        // between a vat reporting its dead imports on this `bringOutYourDead`
        // and reporting them on some later one. Twice, because a drained turn
        // can itself schedule the next.
        await delay(0);
        await delay(0);
        // First GC pass
        gcFunction();
        // Allow finalization callbacks to run
        await delay(0);
        // Second GC pass to clean up objects that might have become
        // unreachable during finalization
        gcFunction();
        // Another tick to ensure finalization completes
        await delay(0);
      } else {
        // No GC function available, log warning and cycle the event loop
        logger?.warn('Deterministic GC not available in this environment');
        await delay(0);
      }
    } catch (error) {
      logger?.warn('GC operation failed:', error);
    }
  };
}
