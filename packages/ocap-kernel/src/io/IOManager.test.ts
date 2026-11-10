import { Logger } from '@metamask/logger';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

import { IOManager } from './IOManager.ts';
import type { IOChannel, IOListener, IOListenerFactory } from './types.ts';
import type { KernelService } from '../KernelServiceManager.ts';
import type { IOConfig, KRef } from '../types.ts';

const makeChannel = (): IOChannel => ({
  read: vi.fn().mockResolvedValue('data'),
  write: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

const makeListener = (): IOListener => ({
  accept: vi.fn().mockImplementation(async () => makeChannel()),
  close: vi.fn().mockResolvedValue(undefined),
});

/** The vat-facing shape of a listener service, for driving it in tests. */
type ListenerFacet = { accept: () => Promise<unknown> };

type IOManagerOptions = ConstructorParameters<typeof IOManager>[0];

describe('IOManager', () => {
  let factory: IOListenerFactory;
  let registerService: Mock<IOManagerOptions['registerService']>;
  let unregisterService: Mock<IOManagerOptions['unregisterService']>;
  let registerAnonymous: Mock<IOManagerOptions['registerAnonymous']>;
  let releaseAnonymous: Mock<IOManagerOptions['releaseAnonymous']>;
  let logger: Logger;
  let manager: IOManager;
  let listeners: IOListener[];
  let registeredServices: Map<string, ListenerFacet>;
  let nextAnonymousId: number;

  beforeEach(() => {
    listeners = [];
    registeredServices = new Map();
    nextAnonymousId = 0;

    factory = vi.fn(async () => {
      const listener = makeListener();
      listeners.push(listener);
      return listener;
    }) as unknown as IOListenerFactory;

    registerService = vi.fn((name: string, service: object): KernelService => {
      registeredServices.set(name, service as unknown as ListenerFacet);
      return { name, kref: `ko${name}` as KRef, service, systemOnly: false };
    });
    unregisterService = vi.fn();
    registerAnonymous = vi.fn((): KRef => {
      nextAnonymousId += 1;
      return `ko${900 + nextAnonymousId}` as KRef;
    });
    releaseAnonymous = vi.fn();
    logger = new Logger('test');

    manager = new IOManager({
      factory,
      registerService,
      unregisterService,
      registerAnonymous,
      releaseAnonymous,
      logger,
    });
  });

  describe('createChannels', () => {
    it('creates listeners and registers services', async () => {
      const ioConfig: Record<string, IOConfig> = {
        repl: { type: 'socket', path: '/tmp/repl.sock' } as IOConfig,
      };

      await manager.createChannels('s1', ioConfig);

      expect(factory).toHaveBeenCalledWith('repl', ioConfig.repl);
      expect(registerService).toHaveBeenCalledWith(
        'io:s1:repl',
        expect.any(Object),
      );
    });

    it('creates multiple listeners', async () => {
      const ioConfig: Record<string, IOConfig> = {
        input: { type: 'socket', path: '/tmp/in.sock' } as IOConfig,
        output: { type: 'socket', path: '/tmp/out.sock' } as IOConfig,
      };

      await manager.createChannels('s1', ioConfig);

      expect(factory).toHaveBeenCalledTimes(2);
      expect(registerService).toHaveBeenCalledTimes(2);
    });

    it('hosts connections accepted through the registered service', async () => {
      await manager.createChannels('s1', {
        repl: { type: 'socket', path: '/tmp/repl.sock' } as IOConfig,
      });

      await registeredServices.get('io:s1:repl')?.accept();

      expect(registerAnonymous).toHaveBeenCalledWith(
        expect.any(Object),
        'io:s1:repl:c1',
      );
    });

    it('cleans up on factory failure', async () => {
      const successListener = makeListener();
      let callCount = 0;
      const failingFactory = vi.fn(async () => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('factory error');
        }
        return successListener;
      }) as unknown as IOListenerFactory;

      const mgr = new IOManager({
        factory: failingFactory,
        registerService,
        unregisterService,
        registerAnonymous,
        releaseAnonymous,
        logger,
      });

      const ioConfig: Record<string, IOConfig> = {
        first: { type: 'socket', path: '/tmp/a.sock' } as IOConfig,
        second: { type: 'socket', path: '/tmp/b.sock' } as IOConfig,
      };

      await expect(mgr.createChannels('s1', ioConfig)).rejects.toThrow(
        'factory error',
      );

      expect(successListener.close).toHaveBeenCalledOnce();
      expect(unregisterService).toHaveBeenCalledWith('io:s1:first');
    });

    it('releases already-accepted connections on factory failure', async () => {
      let callCount = 0;
      const failingFactory = vi.fn(async () => {
        callCount += 1;
        if (callCount === 2) {
          // Accept a connection on the first listener before the second
          // listener's creation blows up, so rollback has something to undo.
          await registeredServices.get('io:s1:first')?.accept();
          throw new Error('factory error');
        }
        return makeListener();
      }) as unknown as IOListenerFactory;

      const mgr = new IOManager({
        factory: failingFactory,
        registerService,
        unregisterService,
        registerAnonymous,
        releaseAnonymous,
        logger,
      });

      await expect(
        mgr.createChannels('s1', {
          first: { type: 'socket', path: '/tmp/a.sock' } as IOConfig,
          second: { type: 'socket', path: '/tmp/b.sock' } as IOConfig,
        }),
      ).rejects.toThrow('factory error');

      expect(releaseAnonymous).toHaveBeenCalledWith('ko901');
    });

    it('does not mask factory error when unregister fails during rollback', async () => {
      const successListener = makeListener();
      let callCount = 0;
      const failingFactory = vi.fn(async () => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('factory error');
        }
        return successListener;
      }) as unknown as IOListenerFactory;

      const failingUnregister = vi.fn(() => {
        throw new Error('unregister boom');
      });
      const errorSpy = vi.spyOn(logger, 'error');

      const mgr = new IOManager({
        factory: failingFactory,
        registerService,
        unregisterService: failingUnregister,
        registerAnonymous,
        releaseAnonymous,
        logger,
      });

      const ioConfig: Record<string, IOConfig> = {
        first: { type: 'socket', path: '/tmp/a.sock' } as IOConfig,
        second: { type: 'socket', path: '/tmp/b.sock' } as IOConfig,
      };

      // Original factory error propagates, not the unregister error
      await expect(mgr.createChannels('s1', ioConfig)).rejects.toThrow(
        'factory error',
      );

      expect(errorSpy).toHaveBeenCalledWith(
        'Error unregistering IO service "io:s1:first":',
        expect.any(Error),
      );
      expect(successListener.close).toHaveBeenCalledOnce();
    });
  });

  describe('destroyChannels', () => {
    it('closes listeners and unregisters services', async () => {
      const ioConfig: Record<string, IOConfig> = {
        repl: { type: 'socket', path: '/tmp/repl.sock' } as IOConfig,
      };

      await manager.createChannels('s1', ioConfig);
      await manager.destroyChannels('s1');

      expect(listeners[0]?.close).toHaveBeenCalledOnce();
      expect(unregisterService).toHaveBeenCalledWith('io:s1:repl');
    });

    it('releases connections still accepted from the listener', async () => {
      await manager.createChannels('s1', {
        repl: { type: 'socket', path: '/tmp/repl.sock' } as IOConfig,
      });
      const service = registeredServices.get('io:s1:repl');
      await service?.accept();
      await service?.accept();

      await manager.destroyChannels('s1');

      expect(releaseAnonymous).toHaveBeenCalledWith('ko901');
      expect(releaseAnonymous).toHaveBeenCalledWith('ko902');
    });

    it('is idempotent for unknown subcluster', async () => {
      expect(await manager.destroyChannels('nonexistent')).toBeUndefined();
    });

    it('handles unregister errors gracefully', async () => {
      const failingUnregister = vi.fn(() => {
        throw new Error('unregister failed');
      });
      const errorSpy = vi.spyOn(logger, 'error');

      const mgr = new IOManager({
        factory,
        registerService,
        unregisterService: failingUnregister,
        registerAnonymous,
        releaseAnonymous,
        logger,
      });

      await mgr.createChannels('s1', {
        ch: { type: 'socket', path: '/tmp/ch.sock' } as IOConfig,
      });
      await mgr.destroyChannels('s1');

      expect(errorSpy).toHaveBeenCalledWith(
        'Error unregistering IO service "io:s1:ch":',
        expect.any(Error),
      );
      // Listener should still be closed despite unregister failure
      expect(listeners[0]?.close).toHaveBeenCalledOnce();
    });

    it('handles close errors gracefully', async () => {
      const errorListener = makeListener();
      (errorListener.close as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('close failed'),
      );

      const errorFactory = vi.fn(
        async () => errorListener,
      ) as unknown as IOListenerFactory;
      const errorSpy = vi.spyOn(logger, 'error');

      const mgr = new IOManager({
        factory: errorFactory,
        registerService,
        unregisterService,
        registerAnonymous,
        releaseAnonymous,
        logger,
      });

      await mgr.createChannels('s1', {
        ch: { type: 'socket', path: '/tmp/ch.sock' } as IOConfig,
      });
      await mgr.destroyChannels('s1');

      expect(errorSpy).toHaveBeenCalledWith(
        'Error closing IO listener "ch":',
        expect.any(Error),
      );
    });
  });

  describe('destroyAllChannels', () => {
    it('destroys listeners for all subclusters', async () => {
      await manager.createChannels('s1', {
        a: { type: 'socket', path: '/tmp/a.sock' } as IOConfig,
      });
      await manager.createChannels('s2', {
        b: { type: 'socket', path: '/tmp/b.sock' } as IOConfig,
      });

      await manager.destroyAllChannels();

      expect(listeners[0]?.close).toHaveBeenCalledOnce();
      expect(listeners[1]?.close).toHaveBeenCalledOnce();
      expect(unregisterService).toHaveBeenCalledWith('io:s1:a');
      expect(unregisterService).toHaveBeenCalledWith('io:s2:b');
    });

    it('is safe to call when no listeners exist', async () => {
      expect(await manager.destroyAllChannels()).toBeUndefined();
    });
  });
});
