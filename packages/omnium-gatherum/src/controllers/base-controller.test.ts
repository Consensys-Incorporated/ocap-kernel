import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Logger } from '@metamask/logger';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Controller } from './base-controller.ts';
import type { ControllerConfig } from './base-controller.ts';
import { ControllerStorage } from './storage/controller-storage.ts';
import type { StorageAdapter } from './storage/types.ts';
import { makeMockStorageAdapter } from '../../test/utils.ts';

vi.useFakeTimers();

/**
 * Test state for the concrete test controller.
 */
type TestState = {
  items: Record<string, { name: string; value: number }>;
  count: number;
};

/**
 * Test methods for the concrete test controller.
 */
type TestMethods = {
  addItem: (id: string, name: string, value: number) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  clearState: () => void;
  getState: () => Readonly<TestState>;
};

/**
 * Concrete controller for testing the abstract Controller base class.
 */
class TestController extends Controller<
  'TestController',
  TestState,
  TestMethods
> {
  // oxlint-disable-next-line ocap/no-restricted-syntax -- TypeScript doesn't support # for constructors
  private constructor(storage: ControllerStorage<TestState>, logger: Logger) {
    super('TestController', storage, logger);
    harden(this);
  }

  static async make(
    config: ControllerConfig,
    adapter: StorageAdapter,
  ): Promise<TestMethods> {
    const storage = await ControllerStorage.make({
      namespace: 'test',
      adapter,
      makeDefaultState: () => ({
        items: {},
        count: 0,
      }),
      logger: config.logger,
      debounceMs: 10,
    });

    const controller = new TestController(storage, config.logger);
    return controller.makeFacet();
  }

  makeFacet(): TestMethods {
    return makeDefaultExo('TestController', {
      addItem: async (
        id: string,
        name: string,
        value: number,
      ): Promise<void> => {
        this.logger.info(`Adding item: ${id}`);
        this.update((draft) => {
          draft.items[id] = { name, value };
          draft.count += 1;
        });
      },
      removeItem: async (id: string): Promise<void> => {
        this.logger.info(`Removing item: ${id}`);
        this.update((draft) => {
          delete draft.items[id];
          draft.count -= 1;
        });
      },
      clearState: (): void => {
        this.clearState();
      },
      getState: (): Readonly<TestState> => {
        return this.state;
      },
    });
  }
}
harden(TestController);

describe('Controller', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    subLogger: vi.fn().mockReturnThis(),
  };

  const config: ControllerConfig = {
    logger: mockLogger as unknown as ControllerConfig['logger'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('state access', () => {
    it('provides read-only access to state', async () => {
      const mockAdapter = makeMockStorageAdapter();
      await mockAdapter.set('test.items', { foo: { name: 'Foo', value: 42 } });
      await mockAdapter.set('test.count', 1);

      const controller = await TestController.make(config, mockAdapter);

      const state = controller.getState();

      expect(state.items.foo).toStrictEqual({ name: 'Foo', value: 42 });
      expect(state.count).toBe(1);
    });
  });

  describe('state updates', () => {
    it('updates state through update method', async () => {
      const mockAdapter = makeMockStorageAdapter();
      const controller = await TestController.make(config, mockAdapter);

      await controller.addItem('test', 'Test Item', 100);

      const state = controller.getState();
      expect(state.items.test).toStrictEqual({ name: 'Test Item', value: 100 });
    });

    it('removes item from state', async () => {
      const mockAdapter = makeMockStorageAdapter();
      await mockAdapter.set('test.items', { foo: { name: 'Foo', value: 42 } });
      await mockAdapter.set('test.count', 1);

      const controller = await TestController.make(config, mockAdapter);

      await controller.removeItem('foo');

      const state = controller.getState();
      expect(state.items.foo).toBeUndefined();
    });

    it('persists state modifications to storage', async () => {
      const mockAdapter = makeMockStorageAdapter();
      const controller = await TestController.make(config, mockAdapter);

      await controller.addItem('a', 'A', 1);
      await controller.addItem('b', 'B', 2);
      await controller.removeItem('a');

      // Wait for debounced persistence
      await vi.runAllTimersAsync();

      // Check that state was persisted
      const items = await mockAdapter.get('test.items');
      const count = await mockAdapter.get('test.count');
      expect(items).toStrictEqual({ b: { name: 'B', value: 2 } });
      expect(count).toBe(1);
    });
  });

  describe('logging', () => {
    it('logs through provided logger', async () => {
      const mockAdapter = makeMockStorageAdapter();
      const controller = await TestController.make(config, mockAdapter);

      await controller.addItem('test', 'Test', 1);

      expect(mockLogger.info).toHaveBeenCalledWith('Adding item: test');
    });
  });

  describe('clearState', () => {
    it('clears state through clearState method', async () => {
      const mockAdapter = makeMockStorageAdapter();
      const controller = await TestController.make(config, mockAdapter);
      await controller.addItem('a', 'A', 1);

      const stateBefore = controller.getState();
      expect(stateBefore.items).toStrictEqual({ a: { name: 'A', value: 1 } });
      expect(stateBefore.count).toBe(1);

      controller.clearState();

      const stateAfter = controller.getState();
      expect(stateAfter).not.toBe(stateBefore);
      expect(stateAfter).toStrictEqual({ items: {}, count: 0 });
    });

    it('persists cleared state', async () => {
      const mockAdapter = makeMockStorageAdapter();
      const controller = await TestController.make(config, mockAdapter);
      await controller.addItem('a', 'A', 1);

      // Wait for debounced persistence
      await vi.runAllTimersAsync();

      controller.clearState();

      // Wait for debounced persistence
      await vi.runAllTimersAsync();

      const items = await mockAdapter.get('test.items');
      const count = await mockAdapter.get('test.count');
      expect(items).toStrictEqual({});
      expect(count).toBe(0);
    });
  });

  describe('makeFacet', () => {
    it('methods work correctly through exo', async () => {
      const mockAdapter = makeMockStorageAdapter();
      const facet = await TestController.make(config, mockAdapter);

      await facet.addItem('x', 'X', 10);
      const state = facet.getState();

      expect(state.items.x).toStrictEqual({ name: 'X', value: 10 });
      expect(state.count).toBe(1);
    });
  });
});
