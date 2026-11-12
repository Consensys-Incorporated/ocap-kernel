import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

type QueueMessageResult = { body: string; slots: string[]; kpid?: string };

type KernelFacet = {
  queueMessage: (
    target: string,
    method: string,
    args: unknown[],
  ) => Promise<QueueMessageResult>;
  releaseResult: (result: QueueMessageResult) => Promise<void>;
};

/**
 * A vat whose bootstrap answers with an object, and which, given the kernel
 * facet, queues messages through it and releases their results.
 *
 * @returns The root object.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  let kernelFacet: KernelFacet | undefined;
  const gift = makeDefaultExo('Gift', {
    getValue: () => 'gift',
  });

  return makeDefaultExo('root', {
    bootstrap(_vats: unknown, services: { kernelFacet?: KernelFacet }) {
      kernelFacet = services?.kernelFacet;
      return gift;
    },

    createObject(id: string) {
      return makeDefaultExo('Made', { getValue: () => id });
    },

    async queueAndRelease(target: string) {
      const result = await E(kernelFacet as KernelFacet).queueMessage(
        target,
        'createObject',
        ['x'],
      );
      await E(kernelFacet as KernelFacet).releaseResult(result);
      return { kpid: result.kpid, slots: result.slots };
    },

    async releaseTwice(target: string) {
      const result = await E(kernelFacet as KernelFacet).queueMessage(
        target,
        'createObject',
        ['y'],
      );
      await E(kernelFacet as KernelFacet).releaseResult(result);
      try {
        await E(kernelFacet as KernelFacet).releaseResult(result);
        return 'second release accepted';
      } catch (error) {
        return `second release refused: ${(error as Error).message}`;
      }
    },
  });
}
