import type { Kernel, KRef } from '@metamask/ocap-kernel';
import { makeKernelFacet, kslot } from '@metamask/ocap-kernel';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeKernelCapTP } from './kernel-captp.ts';
import type { CapTPMessage } from '../../types.ts';

describe('makeKernelCapTP', () => {
  const mockKernel = {
    getPresence: vi
      .fn()
      .mockImplementation(async (kref: KRef, iface: string) =>
        kslot(kref, iface),
      ),
    getStatus: vi.fn(),
    getSubcluster: vi.fn(),
    getSubclusters: vi.fn(),
    getSystemSubclusterRoot: vi.fn(),
    launchSubcluster: vi.fn(),
    pingVat: vi.fn(),
    queueMessage: vi.fn(),
    registerKernelServiceObject: vi.fn(),
    reset: vi.fn(),
    terminateSubcluster: vi.fn(),
    provideFacet: vi.fn(),
  } as unknown as Kernel;

  vi.mocked(mockKernel.provideFacet).mockReturnValue(
    makeKernelFacet(mockKernel),
  );
  let sendMock: (message: CapTPMessage) => void;

  beforeEach(() => {
    sendMock = vi.fn();
  });

  it('returns object with dispatch and abort', () => {
    const capTP = makeKernelCapTP({
      kernel: mockKernel,
      send: sendMock,
    });

    expect(capTP).toHaveProperty('dispatch');
    expect(capTP).toHaveProperty('abort');
    expect(typeof capTP.dispatch).toBe('function');
    expect(typeof capTP.abort).toBe('function');
  });

  it('dispatch returns boolean', () => {
    const capTP = makeKernelCapTP({
      kernel: mockKernel,
      send: sendMock,
    });

    // Dispatch a dummy message - will return false since it's not valid
    const result = capTP.dispatch({ type: 'unknown' });

    expect(typeof result).toBe('boolean');
  });

  it('processes valid CapTP messages without errors', () => {
    const capTP = makeKernelCapTP({
      kernel: mockKernel,
      send: sendMock,
    });

    // Dispatch a valid CapTP message format
    // CapTP uses array-based message format internally
    // A CTP_CALL message triggers method calls on the bootstrap object
    const callMessage: CapTPMessage = {
      type: 'CTP_CALL',
      questionID: 1,
      target: 0, // Bootstrap slot
      method: 'ping',
      args: { body: '[]', slots: [] },
    };

    // Should not throw when processing a message
    expect(() => capTP.dispatch(callMessage)).not.toThrow();
  });

  it('abort does not throw', () => {
    const capTP = makeKernelCapTP({
      kernel: mockKernel,
      send: sendMock,
    });

    expect(() => capTP.abort()).not.toThrow();
  });

  it('abort can be called with a reason', () => {
    const capTP = makeKernelCapTP({
      kernel: mockKernel,
      send: sendMock,
    });

    expect(() => capTP.abort({ reason: 'test shutdown' })).not.toThrow();
  });
});
