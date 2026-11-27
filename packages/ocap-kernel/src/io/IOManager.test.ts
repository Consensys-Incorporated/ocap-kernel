import { Logger } from '@metamask/logger';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

import { IOManager } from './IOManager.ts';
import type { IOChannel, IOListener, IOListenerFactory } from './types.ts';
import type { KernelQueue } from '../KernelQueue.ts';
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
type ListenerFacet = {
  accept: () => Promise<unknown>;
  close: () => Promise<void>;
};

type InboxWork = Parameters<KernelQueue['enqueueInbox']>[1];

/**
 * A queue whose inbox holds each item until `drain` runs it, as the run loop
 * holds one until its crank.
 *
 * @returns The queue, and a function that runs what the inbox holds.
 */
const makeKernelQueue = (): {
  kernelQueue: KernelQueue;
  enqueueInbox: Mock<KernelQueue['enqueueInbox']>;
  drain: () => Promise<void>;
} => {
  const held: (() => Promise<void>)[] = [];
  const enqueueInbox = vi.fn(
    async (_what: string, work: InboxWork) =>
      new Promise((resolve, reject) => {
        held.push(async () => {
          const outcome = await work();
          if ('failure' in outcome) {
            reject(outcome.failure as Error);
          } else {
            resolve(outcome.value);
          }
        });
      }),
  ) as unknown as Mock<KernelQueue['enqueueInbox']>;
  return {
    kernelQueue: { enqueueInbox } as unknown as KernelQueue,
    enqueueInbox,
    drain: async () => {
      // A macrotask, so a service method reaches its inbox call first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const run of held.splice(0)) {
        await run();
      }
    },
  };
};

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
  let kernelQueue: KernelQueue;
  let enqueueInbox: Mock<KernelQueue['enqueueInbox']>;
  let drain: () => Promise<void>;

  /**
   * @param service - A listener service.
   * @returns What its `accept()` gives once its inbox work has run.
   */
  const accept = async (service: ListenerFacet | undefined) => {
    const accepted = service?.accept();
    await drain();
    return accepted;
  };

  beforeEach(() => {
    ({ kernelQueue, enqueueInbox, drain } = makeKernelQueue());
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
      kernelQueue,
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

      const accepted = registeredServices.get('io:s1:repl')?.accept();
      await vi.waitFor(() =>
        expect(enqueueInbox).toHaveBeenCalledWith(
          'host an IO connection',
          expect.any(Function),
        ),
      );
      expect(registerAnonymous).not.toHaveBeenCalled();
      await drain();
      await accepted;

      expect(registerAnonymous).toHaveBeenCalledWith(
        expect.any(Object),
        'io:s1:repl:c1',
      );
    });

    it('releases a closed connection in an inbox crank', async () => {
      await manager.createChannels('s1', {
        repl: { type: 'socket', path: '/tmp/repl.sock' } as IOConfig,
      });
      await accept(registeredServices.get('io:s1:repl'));
      const connection = registerAnonymous.mock.lastCall?.[0] as {
        close: () => Promise<void>;
      };

      const closed = connection.close();
      await vi.waitFor(() =>
        expect(enqueueInbox).toHaveBeenCalledWith(
          'release an IO connection',
          expect.any(Function),
        ),
      );
      expect(releaseAnonymous).not.toHaveBeenCalled();
      await drain();
      await closed;

      expect(releaseAnonymous).toHaveBeenCalledWith('ko901');
    });

    it('drops a connection whose subcluster is destroyed before its crank', async () => {
      await manager.createChannels('s1', {
        repl: { type: 'socket', path: '/tmp/repl.sock' } as IOConfig,
      });
      const accepted = registeredServices.get('io:s1:repl')?.accept();
      await vi.waitFor(() => expect(enqueueInbox).toHaveBeenCalledOnce());

      await manager.destroyChannels('s1');
      await drain();

      await expect(accepted).rejects.toThrow(
        'IO listener "io:s1:repl" is gone; connection "io:s1:repl:c1" was not hosted',
      );
      expect(registerAnonymous).not.toHaveBeenCalled();
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
        kernelQueue,
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
        kernelQueue,
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
      await accept(service);
      await accept(service);

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
        kernelQueue,
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
        kernelQueue,
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
