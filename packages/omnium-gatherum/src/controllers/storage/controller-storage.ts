import type { Logger } from '@metamask/logger';
import type { Json } from '@metamask/utils';
import { enablePatches, produce, produceWithPatches } from 'immer';
import type { Patch } from 'immer';

import type { StorageAdapter } from './types.ts';

// Enable immer patches globally (called once at module load)
enablePatches();

// TODO: Add migration utility for converting from per-key storage format
// (e.g., caplet.{id}.manifest) to consolidated state format (caplet.manifests)
// when there is deployed data to migrate.

/**
 * Configuration for creating a ControllerStorage instance.
 */
export type ControllerStorageConfig<State extends Record<string, Json>> = {
  /** The namespace prefix for storage keys (e.g., 'caplet') */
  namespace: string;
  /** The underlying storage adapter */
  adapter: StorageAdapter;
  /** Default state values - used for initialization and type inference */
  makeDefaultState: () => State;
  /** Logger for storage operations */
  logger: Logger;
  /** Debounce delay in milliseconds (default: 100, set to 0 for tests) */
  debounceMs?: number;
};

/**
 * Internal options passed to constructor after async initialization.
 */
type ControllerStorageOptions<State extends Record<string, Json>> =
  ControllerStorageConfig<State> & {
    /** Initial state loaded from storage */
    initialState: State;
  };

/**
 * ControllerStorage provides a simplified state management interface for controllers.
 *
 * Features:
 * - Flat top-level key mapping: `state.foo` maps to `{namespace}.foo` in storage
 * - Immer-based updates with automatic change detection
 * - Synchronous state updates with debounced persistence
 * - Only modified top-level keys are persisted
 * - Fire-and-forget persistence (errors logged but don't rollback state)
 * - Eager loading on initialization
 *
 * @template State - The state object type (must have Json-serializable values)
 */
export class ControllerStorage<State extends Record<string, Json>> {
  readonly #adapter: StorageAdapter;

  readonly #prefix: string;

  readonly #makeDefaultState: () => State;

  readonly #logger: Logger;

  readonly #debounceMs: number;

  #state: State;

  #pendingPersist: ReturnType<typeof setTimeout> | null = null;

  readonly #pendingKeys: Set<string> = new Set();

  #lastWriteTime: number = 0;

  /**
   * Private constructor - use static make() factory method.
   *
   * @param options - Configuration including initial loaded state.
   */
  // oxlint-disable-next-line ocap/no-restricted-syntax -- TypeScript doesn't support # for constructors
  private constructor(options: ControllerStorageOptions<State>) {
    this.#adapter = options.adapter;
    this.#prefix = `${options.namespace}.`;
    this.#makeDefaultState = options.makeDefaultState;
    this.#logger = options.logger;
    this.#debounceMs = options.debounceMs ?? 100;
    this.#state = options.initialState;
  }

  /**
   * Create a ControllerStorage instance for a controller.
   *
   * This factory function:
   * 1. Loads existing state from storage for the namespace
   * 2. Merges with defaults (storage values take precedence)
   * 3. Returns a hardened ControllerStorage instance
   *
   * @param config - Configuration including namespace, adapter, and default state.
   * @returns Promise resolving to a hardened ControllerStorage instance.
   *
   * @example
   * ```typescript
   * const capletState = await ControllerStorage.make({
   *   namespace: 'caplet',
   *   adapter: storageAdapter,
   *   defaultState: { installed: [], manifests: {} },
   *   logger: logger.subLogger({ tags: ['storage'] }),
   * });
   *
   * // Read state
   * console.log(capletState.state.installed);
   *
   * // Update state (synchronous)
   * capletState.update(draft => {
   *   draft.installed.push('com.example.app');
   * });
   * ```
   */
  static async make<State extends Record<string, Json>>(
    config: ControllerStorageConfig<State>,
  ): Promise<ControllerStorage<State>> {
    const initialState = await this.#loadState(config);
    return harden(
      new ControllerStorage({
        ...config,
        initialState,
      }),
    );
  }

  /**
   * Load all state from storage, merging with defaults.
   * Storage values take precedence over defaults.
   *
   * @param config - Configuration with adapter, namespace, and defaults.
   * @returns The merged state object.
   */
  static async #loadState<State extends Record<string, Json>>(
    config: ControllerStorageConfig<State>,
  ): Promise<State> {
    const { namespace, adapter, makeDefaultState } = config;
    const prefix = `${namespace}.`;
    const allKeys = await adapter.keys(prefix);

    const state = makeDefaultState();

    // Load and merge values from storage
    await Promise.all(
      allKeys.map(async (fullKey) => {
        const key = fullKey.slice(prefix.length) as keyof State;
        const value = await adapter.get<Json>(fullKey);
        if (value !== undefined) {
          state[key] = value as State[keyof State];
        }
      }),
    );

    return produce({}, (draft) => {
      Object.assign(draft, state);
    }) as State;
  }

  /**
   * Current state (readonly, deeply frozen by immer).
   * Access individual properties: `storage.state.installed`
   *
   * @returns The current readonly state.
   */
  get state(): Readonly<State> {
    return this.#state;
  }

  /**
   * Update state using an immer producer function.
   * State is updated synchronously in memory.
   * Persistence is queued and debounced (fire-and-forget).
   *
   * @param producer - Function that mutates a draft of the state or returns new state
   *
   * @example
   * ```typescript
   * // Mutate draft
   * storage.update(draft => {
   *   draft.installed.push('com.example.app');
   *   draft.manifests['com.example.app'] = manifest;
   * });
   */
  update(producer: (draft: State) => void): void {
    const [nextState, patches] = produceWithPatches(this.#state, (draft) => {
      // @ts-expect-error - ~infinite type recursion (ts2589)
      const result = producer(draft);
      if (result !== undefined) {
        throw new Error('Controller producers must return undefined');
      }
    });

    if (patches.length === 0) {
      return;
    }

    this.#state = nextState;
    this.#schedulePersist(patches);
  }

  /**
   * Clear all state and reset to default values.
   */
  clear(): void {
    this.update((draft) => {
      Object.assign(draft, this.#makeDefaultState());
    });
  }

  /**
   * Schedule debounced persistence with key accumulation.
   * Implements bounded latency (timer not reset) and immediate writes after idle.
   *
   * @param patches - Immer patches describing changes.
   */
  #schedulePersist(patches: Patch[]): void {
    const now = Date.now();
    const timeSinceLastWrite = now - this.#lastWriteTime;
    this.#lastWriteTime = now;

    const modifiedKeys = this.#getModifiedKeys(patches);
    for (const key of modifiedKeys) {
      this.#pendingKeys.add(key);
    }

    if (
      timeSinceLastWrite > this.#debounceMs &&
      this.#pendingPersist === null
    ) {
      this.#flushPendingWrites();
      return;
    }

    this.#pendingPersist ??= setTimeout(() => {
      this.#flushPendingWrites();
    }, this.#debounceMs);
  }

  /**
   * Flush pending writes to storage.
   * Captures accumulated keys and persists current state values.
   */
  #flushPendingWrites(): void {
    const keysToWrite = new Set(this.#pendingKeys);
    this.#pendingKeys.clear();
    this.#pendingPersist = null;

    // Persist current state values for accumulated keys
    this.#persistAccumulatedKeys(this.#state, keysToWrite).catch((error) => {
      this.#logger.error('Failed to persist state changes:', error);
    });
  }

  /**
   * Persist accumulated keys to storage.
   * Always persists current state values (last-write-wins).
   *
   * @param state - The current state to persist from.
   * @param keys - Set of top-level keys to persist.
   */
  async #persistAccumulatedKeys(
    state: State,
    keys: Set<string>,
  ): Promise<void> {
    await Promise.all(
      Array.from(keys).map(async (key) => {
        const storageKey = this.#buildKey(key);
        // Correct use of the controller API guarantees that the key is defined.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const value = state[key]!;
        await this.#adapter.set(storageKey, value);
      }),
    );
  }

  /**
   * Extract top-level keys that were modified from immer patches.
   *
   * @param patches - Array of immer patches describing changes.
   * @returns Set of modified top-level keys.
   */
  #getModifiedKeys(patches: Patch[]): Set<string> {
    const keys = new Set<string>();
    for (const patch of patches) {
      // The first element of path is always the top-level key
      if (patch.path.length > 0) {
        keys.add(String(patch.path[0]));
      }
      // Because we forbid producers from returning a new state, there will be
      // no patches with `path: []` (i.e. where the entire state was replaced).
    }
    return keys;
  }

  /**
   * Build a storage key from a state property name.
   *
   * @param stateKey - The state property name.
   * @returns The namespaced storage key.
   */
  #buildKey(stateKey: string): string {
    return `${this.#prefix}${stateKey}`;
  }
}
harden(ControllerStorage);
