import { describe, it, expect, vi } from 'vitest';

import { kslot } from './liveslots/kernel-marshal.ts';
import { setUpRealKernel } from '../test/real-kernel.ts';

describe('a send still queued when its sender is terminated, on a real kernel', () => {
  it('is delivered, and its receiver answers it', async () => {
    const harness = await setUpRealKernel();
    await harness.stall();
    // Both wait for the stalled crank, so the termination is queued ahead of
    // the send the relay makes.
    harness.kernel
      .queueMessage(harness.doomedRoot, 'relay', [kslot(harness.waiterRoot)])
      .catch(() => undefined);
    const terminated = harness.kernel.terminateVat(harness.doomedId);
    harness.release({ didDelivery: harness.waiterId });
    await terminated;
    await vi.waitFor(() => expect(harness.received).toContain('v1:answer'));

    await harness.kernel.queueMessage(harness.waiterRoot, 'answer', []);
    expect({
      received: harness.received.slice(-4),
      terminated: harness.terminated,
      runLoop: (await harness.kernel.getStatus()).runLoop.state,
    }).toStrictEqual({
      received: ['v1:stall', 'v2:relay', 'v1:answer', 'v1:answer'],
      terminated: ['v2'],
      runLoop: 'running',
    });
  });
});
