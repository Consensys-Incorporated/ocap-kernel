import type { Logger } from '@metamask/logger';
import { vi } from 'vitest';

import { makeMapKernelDatabase } from './storage.ts';
import type { KernelQueue } from '../src/KernelQueue.ts';
import { RemoteHandle } from '../src/remotes/kernel/RemoteHandle.ts';
import type {
  RemoteComms,
  RemoteMessageHandler,
} from '../src/remotes/types.ts';
import type { KernelStore } from '../src/store/index.ts';
import { makeKernelStore } from '../src/store/index.ts';
import type { PlatformServices } from '../src/types.ts';

/**
 * Default configuration for mock remotes components
 */
export type MockRemotesConfig = {
  peerId?: string;
  remoteId?: string;
  remotePeerId?: string;
  kernelStore?: KernelStore;
  logger?: unknown;
};

/**
 * Mock factory for remotes components
 */
export class MockRemotesFactory {
  config: MockRemotesConfig;

  /**
   * Creates a new MockRemotesFactory instance.
   *
   * @param config - Configuration options for the mock factory.
   */
  constructor(config: MockRemotesConfig = {}) {
    this.config = {
      peerId: 'test-peer-id',
      remoteId: 'r0',
      remotePeerId: 'remote-peer-id',
      kernelStore: makeKernelStore(makeMapKernelDatabase()),
      logger: undefined,
      ...config,
    };
  }

  /**
   * Creates a mock PlatformServices with all required methods
   *
   * @returns The mock PlatformServices
   */
  makeMockPlatformServices(): PlatformServices {
    return {
      launch: vi.fn(),
      terminate: vi.fn(),
      terminateAll: vi.fn(),
      initializeRemoteComms: vi.fn(),
      sendRemoteMessage: vi.fn().mockResolvedValue(undefined),
      stopRemoteComms: vi.fn(),
      closeConnection: vi.fn(),
      registerLocationHints: vi.fn(),
      reconnectPeer: vi.fn(),
      resetAllBackoffs: vi.fn(),
      getListenAddresses: vi.fn().mockReturnValue([]),
    };
  }

  /**
   * Creates a mock KernelQueue with all required methods
   *
   * @returns The mock KernelQueue
   */
  makeMockKernelQueue(): KernelQueue {
    return {
      enqueueMessage: vi.fn(),
      enqueueSend: vi.fn(),
      enqueueNotify: vi.fn(),
      enqueueRemoteInbound: vi.fn(),
      resolvePromises: vi.fn(),
      assertRunLoopAlive: vi.fn(),
      waitForCrank: vi.fn(),
      run: vi.fn(),
    } as unknown as KernelQueue;
  }

  /**
   * Creates a mock RemoteComms with all required methods
   *
   * @param overrides The overrides for the mock RemoteComms
   * @returns The mock RemoteComms
   */
  makeMockRemoteComms(overrides: Partial<RemoteComms> = {}): RemoteComms {
    return {
      getPeerId: vi.fn().mockReturnValue(this.config.peerId),
      sendRemoteMessage: vi.fn().mockResolvedValue(undefined),
      issueOcapURL: vi
        .fn()
        .mockResolvedValue(`ocap:abc123@${this.config.peerId}`),
      redeemLocalOcapURL: vi.fn().mockResolvedValue('ko123'),
      addKnownRelays: vi.fn(),
      registerLocationHints: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  /**
   * Creates a mock RemoteMessageHandler
   *
   * @returns The mock RemoteMessageHandler
   */
  makeMockRemoteMessageHandler(): RemoteMessageHandler {
    return vi.fn() as unknown as RemoteMessageHandler;
  }

  /**
   * Creates a mock RemoteHandle using the factory method
   *
   * @param overrides The overrides for the mock RemoteHandle
   * @returns The mock RemoteHandle
   */
  makeMockRemoteHandle(overrides: Partial<RemoteComms> = {}): RemoteHandle {
    const mockRemoteComms = this.makeMockRemoteComms(overrides);
    const mockKernelQueue = this.makeMockKernelQueue();

    return RemoteHandle.make({
      remoteId: this.config.remoteId as string,
      peerId: this.config.remotePeerId as string,
      kernelStore: this.config.kernelStore as KernelStore,
      kernelQueue: mockKernelQueue,
      remoteComms: mockRemoteComms,
      logger: this.config.logger as Logger,
    });
  }

  /**
   * Creates a complete set of mocks for testing RemoteManager
   *
   * @returns The mock RemoteManager
   */
  makeRemoteManagerMocks() {
    return {
      platformServices: this.makeMockPlatformServices(),
      kernelStore: this.config.kernelStore as KernelStore,
      kernelQueue: this.makeMockKernelQueue(),
      remoteComms: this.makeMockRemoteComms(),
      logger: this.config.logger as Logger,
    };
  }

  /**
   * Creates a complete set of mocks for testing OcapURLManager
   *
   * @returns The mock OcapURLManager
   */
  makeOcapURLManagerMocks() {
    const remoteComms = this.makeMockRemoteComms();
    const remoteHandle = this.makeMockRemoteHandle();

    return {
      remoteManager: {
        getRemoteComms: vi.fn().mockReturnValue(remoteComms),
        getRemoteIdentity: vi.fn().mockReturnValue(remoteComms),
        remoteFor: vi.fn().mockReturnValue(remoteHandle),
      },
      remoteComms,
      remoteHandle,
      kernelStore: this.config.kernelStore as KernelStore,
    };
  }

  /**
   * Creates a complete set of mocks for testing RemoteHandle
   *
   * @returns The mock RemoteHandle
   */
  makeRemoteHandleMocks() {
    const kernelStore = this.config.kernelStore as KernelStore;
    const kernelQueue = this.makeMockKernelQueue();
    const remoteComms = this.makeMockRemoteComms();

    return {
      kernelStore,
      kernelQueue,
      remoteComms,
      remoteHandle: this.makeMockRemoteHandle(),
    };
  }

  /**
   * Creates a complete set of mocks for testing remote-comms
   *
   * @returns The mock RemoteComms
   */
  makeRemoteCommsMocks() {
    return {
      kernelStore: this.config.kernelStore as KernelStore,
      platformServices: this.makeMockPlatformServices(),
      remoteMessageHandler: this.makeMockRemoteMessageHandler(),
    };
  }
}

/**
 * Convenience function to create a new MockRemotesFactory with default config
 *
 * @param config The configuration
 * @returns The mock RemotesFactory
 */
export function createMockRemotesFactory(
  config: MockRemotesConfig = {},
): MockRemotesFactory {
  return new MockRemotesFactory(config);
}
