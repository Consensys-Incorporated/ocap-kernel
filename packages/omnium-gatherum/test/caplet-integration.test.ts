import type { Logger } from '@metamask/logger';
import type {
  KRef,
  SubclusterId,
  SubclusterLaunchResult,
} from '@metamask/ocap-kernel';
import type { Json } from '@metamask/utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { echoCapletManifest } from './fixtures/manifests.ts';
import { makeMockStorageAdapter } from './utils.ts';
import { CapletController } from '../src/controllers/caplet/caplet-controller.ts';
import type {
  CapletControllerFacet,
  CapletControllerDeps,
} from '../src/controllers/caplet/caplet-controller.ts';

const makeMockLogger = (): Logger => {
  const mockLogger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    subLogger: vi.fn(() => mockLogger),
  } as unknown as Logger;
  return mockLogger;
};

describe('Caplet Integration - Echo Caplet', () => {
  let capletController: CapletControllerFacet;
  let mockStorage: Map<string, Json>;
  let mockSubclusterCounter: number;

  beforeEach(async () => {
    mockStorage = new Map();
    mockSubclusterCounter = 0;

    const mockLogger = makeMockLogger();
    const mockAdapter = makeMockStorageAdapter(mockStorage);

    const mockLaunchSubcluster = vi.fn(
      async (): Promise<SubclusterLaunchResult> => {
        mockSubclusterCounter += 1;
        return {
          subclusterId:
            `test-subcluster-${mockSubclusterCounter}` as SubclusterId,
          rootKref: `ko${mockSubclusterCounter}` as KRef,
          bootstrapResult: undefined,
          vatRootKrefs: {},
        };
      },
    );

    const mockTerminateSubcluster = vi.fn(async () => {
      // No-op for tests
    });

    const mockGetVatRoot = vi.fn(async (krefString: string) => {
      // In real implementation, this returns a CapTP presence
      // For tests, we return a mock object
      return { kref: krefString };
    });

    const deps: CapletControllerDeps = {
      adapter: mockAdapter,
      launchSubcluster: mockLaunchSubcluster,
      terminateSubcluster: mockTerminateSubcluster,
      getVatRoot: mockGetVatRoot,
    };

    capletController = await CapletController.make(
      { logger: mockLogger },
      deps,
    );
  });

  it('installs a caplet', async () => {
    const result = await capletController.install(echoCapletManifest);

    expect(result.capletId).toBe('echo');
    expect(result.subclusterId).toBe('test-subcluster-1');
  });

  it('retrieves installed a caplet', async () => {
    await capletController.install(echoCapletManifest);

    const caplet = capletController.get('echo');

    expect(caplet).toStrictEqual({
      manifest: {
        id: 'echo',
        name: 'Echo Caplet',
        version: '1.0.0',
        bundleSpec: expect.anything(),
      },
      subclusterId: 'test-subcluster-1',
      rootKref: 'ko1',
      installedAt: expect.any(Number),
    });
  });

  it('lists all installed caplets', async () => {
    const emptyList = capletController.list();
    expect(emptyList).toHaveLength(0);

    await capletController.install(echoCapletManifest);

    const list = capletController.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.manifest.id).toBe('echo');
  });

  it('uninstalls a caplet', async () => {
    await capletController.install(echoCapletManifest);

    let list = capletController.list();
    expect(list).toHaveLength(1);

    await capletController.uninstall('echo');

    list = capletController.list();
    expect(list).toHaveLength(0);

    const caplet = capletController.get('echo');
    expect(caplet).toBeUndefined();
  });

  it('prevents duplicate installations', async () => {
    await capletController.install(echoCapletManifest);

    await expect(capletController.install(echoCapletManifest)).rejects.toThrow(
      'already installed',
    );
  });

  it('handles uninstalling non-existent caplet', async () => {
    await expect(
      capletController.uninstall('com.example.nonexistent'),
    ).rejects.toThrow('not found');
  });

  it('gets caplet root object', async () => {
    await capletController.install(echoCapletManifest);

    const rootPresence = await capletController.getCapletRoot('echo');

    expect(rootPresence).toStrictEqual({ kref: 'ko1' });
  });

  it('throws when getting root for non-existent caplet', async () => {
    await expect(
      capletController.getCapletRoot('com.example.nonexistent'),
    ).rejects.toThrow('not found');
  });

  it('persists caplet state across controller restarts', async () => {
    await capletController.install(echoCapletManifest);

    // Simulate a restart by creating a new controller with the same storage
    const mockLogger = makeMockLogger();

    const newDeps: CapletControllerDeps = {
      adapter: makeMockStorageAdapter(mockStorage),
      launchSubcluster: vi.fn(async (): Promise<SubclusterLaunchResult> => ({
        subclusterId: 'test-subcluster' as SubclusterId,
        rootKref: 'ko1' as KRef,
        bootstrapResult: undefined,
        vatRootKrefs: {},
      })),
      terminateSubcluster: vi.fn(),
      getVatRoot: vi.fn(async (krefString: string) => ({ kref: krefString })),
    };

    const newController = await CapletController.make(
      { logger: mockLogger },
      newDeps,
    );

    // The caplet should still be there
    const list = newController.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.manifest.id).toBe('echo');
  });
});
