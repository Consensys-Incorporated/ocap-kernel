import type { MockedFunction } from 'vitest';
import { vi } from 'vitest';

import type { KernelStore } from '../src/store/index.ts';

export type FailingReleaseStore = {
  /** The store to hand the subject under test. */
  kernelStore: KernelStore;
  /** The error every `releaseSavepoint` throws. */
  releaseFailure: Error;
  /** Exposed so a test can assert the rollback was still attempted. */
  rollbackSavepoint: MockedFunction<(name: string) => void>;
};

/**
 * Wrap a kernel store so that `releaseSavepoint` fails the way a full disk does,
 * modelling the drivers' bookkeeping as of #1012 and verified against both: a
 * failed RELEASE clears the savepoint stack, and rolling back a name that is no
 * longer on it throws `No such savepoint`. What is under test is therefore the
 * caller's error handling, not an expected outcome baked into the mock.
 *
 * Replaces the store wholesale rather than assigning over its methods, because
 * `makeKernelStore` hardens what it returns.
 *
 * @param kernelStore - The store to wrap.
 * @returns The wrapped store and the handles a test needs to assert against.
 */
export function withFailingSavepointRelease(
  kernelStore: KernelStore,
): FailingReleaseStore {
  const savepoints: string[] = [];
  const releaseFailure = new Error('database or disk is full');
  const rollbackSavepoint = vi.fn((name: string) => {
    if (!savepoints.includes(name)) {
      throw new Error(`No such savepoint: ${name}`);
    }
  });
  return {
    kernelStore: {
      ...kernelStore,
      createSavepoint: (name: string) => {
        savepoints.push(name);
      },
      releaseSavepoint: () => {
        savepoints.length = 0;
        throw releaseFailure;
      },
      rollbackSavepoint,
    },
    releaseFailure,
    rollbackSavepoint,
  };
}
