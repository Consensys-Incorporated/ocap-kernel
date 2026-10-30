import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import { RemoteHandle } from './remotes/kernel/RemoteHandle.ts';
import { makeKernelStore } from './store/index.ts';
import { makeGCAction } from './types.ts';
import { asRRef, asRemoteId, asVatId } from '../test/branded.ts';
import { createMockRemotesFactory } from '../test/remotes-mocks.ts';

const v1 = asVatId('v1');
const r1 = asRemoteId('r1');

describe('a GC action for a remote restored at boot', () => {
  it('joins its queue before remote comms start, and goes out once they do', async () => {
    const kernelStore = makeKernelStore(
      await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
    );
    kernelStore.initEndpoint(v1);
    kernelStore.initEndpoint(r1);
    const kref = kernelStore.initKernelObject(v1);
    kernelStore.addCListEntry(r1, kref, asRRef('ro-1'));
    kernelStore.addGCActions([makeGCAction(r1, 'retireImport', kref)]);

    const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
    const remote = RemoteHandle.make({
      remoteId: r1,
      peerId: 'peer-1',
      kernelStore,
      kernelQueue,
    });
    const kernelRouter = new KernelRouter({
      kernelStore,
      kernelQueue,
      getEndpoint: () => remote,
      invokeKernelService: () => undefined,
      restartVat: async () => undefined,
      terminateVat: async () => undefined,
      applyIncarnationChange: () => ({}),
      performControl: async () => undefined,
    });
    const running = kernelQueue.run(kernelRouter.deliver.bind(kernelRouter));
    await waitUntilQuiescent();
    const beforeComms = {
      gcActions: [...kernelStore.getGCActions()],
      inCList: kernelStore.hasCListEntry(r1, kref),
      queued: JSON.parse(kernelStore.getPendingMessage(r1, 1) ?? '{}').params,
    };

    const remoteComms = createMockRemotesFactory().makeMockRemoteComms();
    remote.attachTransport({ remoteComms });
    await waitUntilQuiescent();
    // Clears the ACK timer the send armed.
    remote.cleanup();
    await kernelQueue.endRunLoop();
    await running;

    expect({
      beforeComms,
      sent: vi
        .mocked(remoteComms.sendRemoteMessage)
        .mock.calls.map(([peerId, message]) => [
          peerId,
          JSON.parse(message).params,
        ]),
    }).toStrictEqual({
      beforeComms: {
        gcActions: [],
        inCList: false,
        queued: ['retireImports', ['ro+1']],
      },
      sent: [['peer-1', ['retireImports', ['ro+1']]]],
    });
  });
});
