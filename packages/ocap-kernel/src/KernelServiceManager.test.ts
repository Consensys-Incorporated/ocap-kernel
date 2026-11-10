import { delay } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { KernelQueue } from './KernelQueue.ts';
import { KernelServiceManager } from './KernelServiceManager.ts';
import { kser, kslot, makeKernelError } from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type { KernelMessage } from './types.ts';
import { asKRef } from '../test/branded.ts';
import { makeMapKernelDatabase } from '../test/storage.ts';

/**
 * Create a trackable service method that records calls without using vi.fn(),
 * which doesn't work well with E() under SES/lockdown (frozen mock state).
 *
 * @param implementation - Optional implementation to call.
 * @returns An object with the method and call tracking state.
 */
function makeTrackableMethod(implementation?: (...args: unknown[]) => unknown) {
  const calls: unknown[][] = [];
  const method = (...args: unknown[]) => {
    calls.push(args);
    return implementation?.(...args);
  };
  return { method, calls };
}

describe('KernelServiceManager', () => {
  let serviceManager: KernelServiceManager;
  let kernelStore: ReturnType<typeof makeKernelStore>;
  let mockKernelQueue: KernelQueue;
  let logger: Logger;

  beforeEach(() => {
    const kernelDatabase = makeMapKernelDatabase();
    const realKernelStore = makeKernelStore(kernelDatabase);
    logger = new Logger('test');

    // Create a mock kernelStore with spyable methods
    kernelStore = {
      ...realKernelStore,
      pinObject: vi.fn().mockImplementation(realKernelStore.pinObject),
      initKernelObject: vi
        .fn()
        .mockImplementation(realKernelStore.initKernelObject),
    };

    mockKernelQueue = {
      enqueueMessage: vi.fn(),
      resolvePromises: vi.fn(),
      waitForCrank: vi.fn(),
      run: vi.fn(),
    } as unknown as KernelQueue;

    serviceManager = new KernelServiceManager({
      kernelStore,
      kernelQueue: mockKernelQueue,
      logger,
    });
  });

  describe('registerKernelServiceObject', () => {
    it('registers a kernel service and return service info', () => {
      // Use a plain object instead of Far for testing
      const testService = {
        testMethod: () => 'test result',
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      expect(registered.name).toBe('testService');
      expect(registered.kref).toMatch(/^ko\d+$/u);
      expect(registered.service).toBe(testService);
      expect(registered.systemOnly).toBe(false);
    });

    it('defaults systemOnly to false when no options provided', () => {
      const testService = { testMethod: () => 'test' };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      expect(registered.systemOnly).toBe(false);
    });

    it('sets systemOnly to true when specified', () => {
      const testService = { testMethod: () => 'test' };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
        { systemOnly: true },
      );

      expect(registered.systemOnly).toBe(true);
    });

    it('pins the service object in kernel store', () => {
      // Use a plain object instead of Far for testing
      const testService = {
        testMethod: () => 'test result',
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      // Verify that initKernelObject and pinObject were called
      expect(kernelStore.initKernelObject).toHaveBeenCalledWith('kernel');
      expect(kernelStore.pinObject).toHaveBeenCalledWith(registered.kref);
      expect(registered.kref).toMatch(/^ko\d+$/u);
    });

    it('allows registering multiple services', () => {
      const service1 = { method1: () => 'result1' };
      const service2 = { method2: () => 'result2' };

      const registered1 = serviceManager.registerKernelServiceObject(
        'service1',
        service1,
      );
      const registered2 = serviceManager.registerKernelServiceObject(
        'service2',
        service2,
      );

      expect(registered1.kref).not.toBe(registered2.kref);
      expect(registered1.name).toBe('service1');
      expect(registered2.name).toBe('service2');
    });

    it('throws when registering a service with a name that is already registered', () => {
      const service1 = { method1: () => 'result1' };
      const service2 = { method2: () => 'result2' };

      serviceManager.registerKernelServiceObject('duplicateName', service1);

      expect(() =>
        serviceManager.registerKernelServiceObject('duplicateName', service2),
      ).toThrow('Kernel service "duplicateName" is already registered');
    });
  });

  describe('unregisterKernelServiceObject', () => {
    it('removes a registered service', () => {
      const testService = { testMethod: () => 'test' };
      serviceManager.registerKernelServiceObject('myService', testService);

      serviceManager.unregisterKernelServiceObject('myService');

      expect(serviceManager.getKernelService('myService')).toBeUndefined();
    });

    it('removes from kref lookup', () => {
      const testService = { testMethod: () => 'test' };
      const registered = serviceManager.registerKernelServiceObject(
        'myService',
        testService,
      );

      serviceManager.unregisterKernelServiceObject('myService');

      expect(
        serviceManager.getKernelServiceByKref(registered.kref),
      ).toBeUndefined();
      expect(serviceManager.isKernelService(registered.kref)).toBe(false);
    });

    it('unpins the object and deletes the KV key', () => {
      const testService = { testMethod: () => 'test' };
      const registered = serviceManager.registerKernelServiceObject(
        'myService',
        testService,
      );

      serviceManager.unregisterKernelServiceObject('myService');

      expect(kernelStore.getKernelServiceKref('myService')).toBeUndefined();
      // Verify it was unpinned by trying to re-register with the same name
      const reregistered = serviceManager.registerKernelServiceObject(
        'myService',
        testService,
      );
      expect(reregistered.kref).not.toBe(registered.kref);
    });

    it('is a no-op for non-existent service', () => {
      expect(() =>
        serviceManager.unregisterKernelServiceObject('nonexistent'),
      ).not.toThrow();
    });

    it('allows re-registration after unregister', () => {
      const service1 = { method: () => 'v1' };
      const service2 = { method: () => 'v2' };

      serviceManager.registerKernelServiceObject('svc', service1);
      serviceManager.unregisterKernelServiceObject('svc');
      const registered = serviceManager.registerKernelServiceObject(
        'svc',
        service2,
      );

      expect(registered.service).toBe(service2);
      expect(serviceManager.getKernelService('svc')?.service).toBe(service2);
    });
  });

  describe('getKernelService', () => {
    it('retrieves registered service by name', () => {
      const testService = {
        testMethod: () => 'test result',
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const retrieved = serviceManager.getKernelService('testService');
      expect(retrieved).toStrictEqual(registered);
    });

    it('returns the systemOnly flag on retrieved service', () => {
      const testService = { testMethod: () => 'test' };

      serviceManager.registerKernelServiceObject('sysOnly', testService, {
        systemOnly: true,
      });
      serviceManager.registerKernelServiceObject('open', testService);

      expect(serviceManager.getKernelService('sysOnly')?.systemOnly).toBe(true);
      expect(serviceManager.getKernelService('open')?.systemOnly).toBe(false);
    });

    it('returns undefined for non-existent service', () => {
      const retrieved = serviceManager.getKernelService('nonExistent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getKernelServiceByKref', () => {
    it('retrieves registered service by kref', () => {
      const testService = {
        testMethod: () => 'test result',
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const retrieved = serviceManager.getKernelServiceByKref(registered.kref);
      expect(retrieved).toStrictEqual(registered);
    });

    it('returns undefined for non-existent kref', () => {
      const retrieved = serviceManager.getKernelServiceByKref(asKRef('ko999'));
      expect(retrieved).toBeUndefined();
    });
  });

  describe('isKernelService', () => {
    it('returns true for registered service kref', () => {
      const testService = {
        testMethod: () => 'test result',
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      expect(serviceManager.isKernelService(registered.kref)).toBe(true);
    });

    it('returns false for non-service kref', () => {
      expect(serviceManager.isKernelService(asKRef('ko999'))).toBe(false);
    });
  });

  describe('invokeKernelService', () => {
    it('successfully invokes a service method without result', async () => {
      const { method: testMethod, calls } = makeTrackableMethod(
        () => 'test result',
      );
      const testService = { testMethod };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const message: KernelMessage = {
        methargs: kser(['testMethod', ['arg1', 'arg2']]),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(calls).toStrictEqual([['arg1', 'arg2']]);
      expect(mockKernelQueue.resolvePromises).not.toHaveBeenCalled();
    });

    it('successfully invokes a service method with result', async () => {
      const { method: testMethod, calls } = makeTrackableMethod(async () =>
        Promise.resolve('test result'),
      );
      const testService = { testMethod };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const message: KernelMessage = {
        methargs: kser(['testMethod', ['arg1']]),
        result: asKRef('kp123'),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(calls).toStrictEqual([['arg1']]);
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        ['kp123', false, kser('test result')],
      ]);
    });

    it('handles errors when invoking service method with result', async () => {
      const testError = new Error('Test error');
      const { method: testMethod } = makeTrackableMethod(async () =>
        Promise.reject(testError),
      );
      const testService = { testMethod };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const message: KernelMessage = {
        methargs: kser(['testMethod', []]),
        result: asKRef('kp123'),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        ['kp123', true, makeKernelError('DELIVERY_FAILED', testError.message)],
      ]);
    });

    it('handles errors when invoking service method without result', async () => {
      const loggerErrorSpy = vi.spyOn(logger, 'error');
      const testError = new Error('Test error');
      const { method: testMethod } = makeTrackableMethod(async () =>
        Promise.reject(testError),
      );
      const testService = { testMethod };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const message: KernelMessage = {
        methargs: kser(['testMethod', []]),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Error in kernel service method:',
        testError,
      );
      expect(mockKernelQueue.resolvePromises).not.toHaveBeenCalled();
    });

    it('rejects the caller for a non-existent service', () => {
      const message: KernelMessage = {
        methargs: kser(['testMethod', []]),
        result: asKRef('kp1'),
      };

      // Must not throw: a throw here escapes the crank and kills the run
      // loop, and this is reachable whenever an anonymous kernel object
      // outlives the process that hosted it.
      expect(() =>
        serviceManager.invokeKernelService(asKRef('ko999'), message),
      ).not.toThrow();
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        [
          'kp1',
          true,
          makeKernelError(
            'ENDPOINT_UNREACHABLE',
            'No registered service for ko999',
          ),
        ],
      ]);
    });

    it('logs for a non-existent service when the message has no result', () => {
      const loggerErrorSpy = vi.spyOn(logger, 'error');
      const message: KernelMessage = {
        methargs: kser(['testMethod', []]),
      };

      expect(() =>
        serviceManager.invokeKernelService(asKRef('ko999'), message),
      ).not.toThrow();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Error in kernel service method:',
        'No registered service for ko999',
      );
      expect(mockKernelQueue.resolvePromises).not.toHaveBeenCalled();
    });

    it('handles unknown method with result', async () => {
      const testService = {
        existingMethod: () => 'test',
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const message: KernelMessage = {
        methargs: kser(['unknownMethod', []]),
        result: asKRef('kp123'),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        [
          'kp123',
          true,
          expect.objectContaining({
            body: expect.stringContaining('unknownMethod'),
          }),
        ],
      ]);
    });

    it('handles unknown method without result', async () => {
      const loggerErrorSpy = vi.spyOn(logger, 'error');
      const testService = {
        existingMethod: () => 'test',
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const message: KernelMessage = {
        methargs: kser(['unknownMethod', []]),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Error in kernel service method:',
        expect.objectContaining({
          message: expect.stringContaining('unknownMethod'),
        }),
      );
      expect(mockKernelQueue.resolvePromises).not.toHaveBeenCalled();
    });

    it('handles service with no methods', async () => {
      const emptyService = {};

      const registered = serviceManager.registerKernelServiceObject(
        'emptyService',
        emptyService,
      );

      const message: KernelMessage = {
        methargs: kser(['anyMethod', []]),
        result: asKRef('kp123'),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        [
          'kp123',
          true,
          expect.objectContaining({
            body: expect.stringContaining('anyMethod'),
          }),
        ],
      ]);
    });

    it('invokes methods on a proxy-based service (simulated remote presence)', async () => {
      const { method: testMethod, calls } = makeTrackableMethod(async () =>
        Promise.resolve('remote result'),
      );
      const proxyService = new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === 'testMethod') {
              return testMethod;
            }
            return undefined;
          },
        },
      );

      const registered = serviceManager.registerKernelServiceObject(
        'proxyService',
        proxyService,
      );

      const message: KernelMessage = {
        methargs: kser(['testMethod', ['arg1']]),
        result: asKRef('kp123'),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(calls).toStrictEqual([['arg1']]);
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        ['kp123', false, kser('remote result')],
      ]);
    });

    it('handles service method that returns undefined', async () => {
      const testService = {
        voidMethod: () => undefined,
      };

      const registered = serviceManager.registerKernelServiceObject(
        'testService',
        testService,
      );

      const message: KernelMessage = {
        methargs: kser(['voidMethod', []]),
        result: asKRef('kp123'),
      };

      serviceManager.invokeKernelService(registered.kref, message);
      await delay();

      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        ['kp123', false, kser(undefined)],
      ]);
    });
  });

  describe('registerAnonymousKernelObject', () => {
    it('hosts the object for routing without naming it', () => {
      const kref = serviceManager.registerAnonymousKernelObject(
        { ping: () => 'pong' },
        'io-connection',
      );

      expect(serviceManager.isKernelService(kref)).toBe(true);
      expect(kernelStore.getOwner(kref)).toBe('kernel');
      expect(kernelStore.pinObject).toHaveBeenCalledWith(kref);
      // The whole point: absent from the global name namespace, so no
      // string can be used to ask for it.
      expect(serviceManager.getKernelService('io-connection')).toBeUndefined();
      // Recorded persistently so a later incarnation can sweep it.
      expect(kernelStore.getAnonymousKernelObjects()).toStrictEqual([kref]);
    });

    it('allows the same label for distinct objects', () => {
      const first = serviceManager.registerAnonymousKernelObject(
        { which: () => 'first' },
        'io-connection',
      );
      const second = serviceManager.registerAnonymousKernelObject(
        { which: () => 'second' },
        'io-connection',
      );

      expect(second).not.toBe(first);
      expect(serviceManager.isKernelService(first)).toBe(true);
      expect(serviceManager.isKernelService(second)).toBe(true);
    });

    it('round-trips through kslot/kser so a service method can return one', () => {
      // This is what makes `accept()` possible: `invokeKernelService`
      // passes a method's return value through `kser`, whose val-to-slot
      // step only accepts standins minted by `kslot`.
      const kref = serviceManager.registerAnonymousKernelObject(
        { ping: () => 'pong' },
        'io-connection',
      );

      expect(kser(kslot(kref))).toStrictEqual({
        body: expect.any(String),
        slots: [kref],
      });
    });

    it('delivers messages to the hosted object', async () => {
      const { method: ping, calls } = makeTrackableMethod(() => 'pong');
      const kref = serviceManager.registerAnonymousKernelObject(
        { ping },
        'io-connection',
      );

      serviceManager.invokeKernelService(kref, {
        methargs: kser(['ping', ['hello']]),
        result: asKRef('kp200'),
      });
      await delay();

      expect(calls).toStrictEqual([['hello']]);
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith('kernel', [
        ['kp200', false, kser('pong')],
      ]);
    });
  });

  describe('releaseAbandonedAnonymousKernelObjects', () => {
    it('discards objects recorded by a previous incarnation', () => {
      // Simulate a restart: the krefs are still recorded in the store, but
      // the in-memory routing table starts empty.
      const stale = kernelStore.initKernelObject('kernel');
      kernelStore.pinObject(stale);
      kernelStore.addAnonymousKernelObject(stale);

      const fresh = new KernelServiceManager({
        kernelStore,
        kernelQueue: mockKernelQueue,
        logger,
      });

      expect(fresh.releaseAbandonedAnonymousKernelObjects()).toBe(1);
      expect(kernelStore.isObjectPinned(stale)).toBe(false);
      expect(kernelStore.getAnonymousKernelObjects()).toStrictEqual([]);
    });

    it('leaves objects hosted by the current incarnation alone', () => {
      const live = serviceManager.registerAnonymousKernelObject(
        { ping: () => 'pong' },
        'io-connection',
      );

      expect(serviceManager.releaseAbandonedAnonymousKernelObjects()).toBe(0);
      expect(serviceManager.isKernelService(live)).toBe(true);
      expect(kernelStore.isObjectPinned(live)).toBe(true);
    });

    it('reports nothing to do when none were recorded', () => {
      expect(serviceManager.releaseAbandonedAnonymousKernelObjects()).toBe(0);
    });
  });

  describe('releaseAnonymousKernelObject', () => {
    it('removes the object from routing and unpins it', () => {
      const kref = serviceManager.registerAnonymousKernelObject(
        { ping: () => 'pong' },
        'io-connection',
      );

      serviceManager.releaseAnonymousKernelObject(kref);

      expect(serviceManager.isKernelService(kref)).toBe(false);
      expect(serviceManager.getKernelServiceByKref(kref)).toBeUndefined();
      expect(kernelStore.isObjectPinned(kref)).toBe(false);
    });

    it('leaves other hosted objects alone', () => {
      const kept = serviceManager.registerAnonymousKernelObject(
        { which: () => 'kept' },
        'io-connection',
      );
      const dropped = serviceManager.registerAnonymousKernelObject(
        { which: () => 'dropped' },
        'io-connection',
      );

      serviceManager.releaseAnonymousKernelObject(dropped);

      expect(serviceManager.isKernelService(kept)).toBe(true);
      expect(serviceManager.isKernelService(dropped)).toBe(false);
    });

    it('is idempotent and tolerates an unregistered kref', () => {
      const kref = serviceManager.registerAnonymousKernelObject(
        { ping: () => 'pong' },
        'io-connection',
      );

      serviceManager.releaseAnonymousKernelObject(kref);
      expect(() =>
        serviceManager.releaseAnonymousKernelObject(kref),
      ).not.toThrow();
      expect(() =>
        serviceManager.releaseAnonymousKernelObject(asKRef('ko9999')),
      ).not.toThrow();
    });
  });
});
