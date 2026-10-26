import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Logger } from '@metamask/logger';
import type {
  ClusterConfig,
  SubclusterLaunchResult,
} from '@metamask/ocap-kernel';

import type {
  CapletId,
  CapletManifest,
  InstalledCaplet,
  InstallResult,
} from './types.ts';
import { isCapletManifest } from './types.ts';
import { Controller } from '../base-controller.ts';
import type { ControllerConfig } from '../base-controller.ts';
import { ControllerStorage } from '../storage/controller-storage.ts';
import type { StorageAdapter } from '../storage/types.ts';

/**
 * Caplet controller persistent state.
 * This is the shape of the state managed by the CapletController
 * through the ControllerStorage abstraction.
 */
export type CapletControllerState = {
  /** Installed caplets keyed by caplet ID */
  caplets: Record<CapletId, InstalledCaplet>;
};

/**
 * Methods exposed by the CapletController.
 */
export type CapletControllerFacet = {
  /**
   * Install a caplet.
   *
   * @param manifest - The caplet manifest.
   * @returns The installation result.
   * @example
   * ```typescript
   * const result = await omnium.caplet.install({
   *   id: 'com.example.test',
   *   name: 'Test Caplet',
   *   version: '1.0.0',
   *   bundleSpec: '/path/to/bundle.json',
   * });
   * ```
   */
  install: (manifest: CapletManifest) => Promise<InstallResult>;

  /**
   * Uninstall a caplet.
   *
   * @param capletId - The ID of the caplet to uninstall.
   */
  uninstall: (capletId: CapletId) => Promise<void>;

  /**
   * List all installed caplets.
   *
   * @returns Array of installed caplets.
   */
  list: () => InstalledCaplet[];

  /**
   * Get a specific installed caplet.
   *
   * @param capletId - The caplet ID.
   * @returns The installed caplet or undefined if not found.
   */
  get: (capletId: CapletId) => InstalledCaplet | undefined;

  /**
   * Get the root object presence for a caplet.
   *
   * @param capletId - The caplet ID.
   * @returns A promise for the caplet's root object (as a CapTP presence).
   */
  getCapletRoot: (capletId: CapletId) => Promise<unknown>;
};

/**
 * Dependencies for the CapletController.
 * These are attenuated - only the methods needed are provided.
 */
export type CapletControllerDeps = {
  /** Storage adapter for creating controller storage */
  adapter: StorageAdapter;
  /** Launch a subcluster for a caplet */
  launchSubcluster: (config: ClusterConfig) => Promise<SubclusterLaunchResult>;
  /** Terminate a caplet's subcluster */
  terminateSubcluster: (subclusterId: string) => Promise<void>;
  /** Get the root object for a vat by kref string */
  getVatRoot: (krefString: string) => Promise<unknown>;
};

/**
 * Controller for managing caplet lifecycle.
 *
 * The CapletController manages:
 * - Installing caplets (validating manifest, launching subcluster, storing metadata)
 * - Uninstalling caplets (terminating subcluster, removing metadata)
 * - Querying installed caplets
 */
export class CapletController extends Controller<
  'CapletController',
  CapletControllerState,
  CapletControllerFacet
> {
  readonly #pendingInstalls: Set<CapletId> = new Set();

  readonly #launchSubcluster: (
    config: ClusterConfig,
  ) => Promise<SubclusterLaunchResult>;

  readonly #terminateSubcluster: (subclusterId: string) => Promise<void>;

  readonly #getVatRoot: (krefString: string) => Promise<unknown>;

  /**
   * Private constructor - use static create() method.
   *
   * @param storage - ControllerStorage for caplet state.
   * @param logger - Logger instance.
   * @param launchSubcluster - Function to launch a subcluster.
   * @param terminateSubcluster - Function to terminate a subcluster.
   * @param getVatRoot - Function to get a vat's root object as a presence.
   */
  // oxlint-disable-next-line ocap/no-restricted-syntax -- TypeScript doesn't support # for constructors
  private constructor(
    storage: ControllerStorage<CapletControllerState>,
    logger: Logger,
    launchSubcluster: (
      config: ClusterConfig,
    ) => Promise<SubclusterLaunchResult>,
    terminateSubcluster: (subclusterId: string) => Promise<void>,
    getVatRoot: (krefString: string) => Promise<unknown>,
  ) {
    super('CapletController', storage, logger);
    this.#launchSubcluster = launchSubcluster;
    this.#terminateSubcluster = terminateSubcluster;
    this.#getVatRoot = getVatRoot;
    harden(this);
  }

  /**
   * Create a CapletController and return its public methods.
   *
   * @param config - Controller configuration.
   * @param deps - Controller dependencies (attenuated for POLA).
   * @returns A hardened CapletController exo.
   */
  static async make(
    config: ControllerConfig,
    deps: CapletControllerDeps,
  ): Promise<CapletControllerFacet> {
    // Create storage internally
    const storage = await ControllerStorage.make({
      namespace: 'caplet',
      adapter: deps.adapter,
      makeDefaultState: () => ({ caplets: {} }),
      logger: config.logger.subLogger({ tags: ['storage'] }),
    });

    const controller = new CapletController(
      storage,
      config.logger,
      deps.launchSubcluster,
      deps.terminateSubcluster,
      deps.getVatRoot,
    );
    return controller.makeFacet();
  }

  /**
   * Returns the hardened exo with public methods.
   *
   * @returns A hardened exo object with the controller's public methods.
   */
  makeFacet(): CapletControllerFacet {
    return makeDefaultExo('CapletController', {
      install: async (manifest: CapletManifest): Promise<InstallResult> => {
        return this.#install(manifest);
      },
      uninstall: async (capletId: CapletId): Promise<void> => {
        return this.#uninstall(capletId);
      },
      list: (): InstalledCaplet[] => {
        return this.#list();
      },
      get: (capletId: CapletId): InstalledCaplet | undefined => {
        return this.#get(capletId);
      },
      getCapletRoot: async (capletId: CapletId): Promise<unknown> => {
        return this.#getCapletRoot(capletId);
      },
    });
  }

  /**
   * Install a caplet.
   *
   * @param manifest - The caplet manifest.
   * @param _bundle - The caplet bundle (currently unused).
   * @returns The installation result.
   */
  async #install(
    manifest: CapletManifest,
    _bundle?: unknown,
  ): Promise<InstallResult> {
    const { id } = manifest;
    this.logger.info(`Installing caplet: ${id}`);

    // TODO: Move this validation in front of the controller.
    if (!isCapletManifest(manifest)) {
      throw new Error(`Invalid caplet manifest for ${id}`);
    }

    if (this.state.caplets[id] !== undefined) {
      throw new Error(`Caplet ${id} is already installed`);
    }

    if (this.#pendingInstalls.has(id)) {
      throw new Error(`Caplet ${id} is already being installed`);
    }
    this.#pendingInstalls.add(id);

    const clusterConfig: ClusterConfig = {
      bootstrap: id,
      vats: {
        [id]: {
          bundleSpec: manifest.bundleSpec,
        },
      },
    };

    try {
      const { subclusterId, rootKref } =
        await this.#launchSubcluster(clusterConfig);

      this.update((draft) => {
        draft.caplets[id] = {
          manifest,
          subclusterId,
          rootKref,
          installedAt: Date.now(),
        };
      });

      this.logger.info(
        `Caplet ${id} installed with subcluster ${subclusterId}`,
      );
      return { capletId: id, subclusterId };
    } finally {
      this.#pendingInstalls.delete(id);
    }
  }

  /**
   * Uninstall a caplet.
   *
   * @param capletId - The ID of the caplet to uninstall.
   */
  async #uninstall(capletId: CapletId): Promise<void> {
    this.logger.info(`Uninstalling caplet: ${capletId}`);

    const caplet = this.state.caplets[capletId];
    if (caplet === undefined) {
      throw new Error(`Caplet ${capletId} not found`);
    }

    await this.#terminateSubcluster(caplet.subclusterId);

    this.update((draft) => {
      delete draft.caplets[capletId];
    });

    this.logger.info(`Caplet ${capletId} uninstalled`);
  }

  /**
   * Get all installed caplets.
   *
   * @returns Array of all installed caplets.
   */
  #list(): InstalledCaplet[] {
    return Object.values(this.state.caplets);
  }

  /**
   * Get an installed caplet by ID.
   *
   * @param capletId - The caplet ID to retrieve.
   * @returns The installed caplet or undefined if not found.
   */
  #get(capletId: CapletId): InstalledCaplet | undefined {
    return this.state.caplets[capletId];
  }

  /**
   * Get the root object presence for a caplet.
   *
   * @param capletId - The caplet ID.
   * @returns A promise for the caplet's root object (as a CapTP presence).
   */
  async #getCapletRoot(capletId: CapletId): Promise<unknown> {
    const caplet = this.state.caplets[capletId];
    if (!caplet) {
      throw new Error(`Caplet ${capletId} not found`);
    }

    if (!caplet.rootKref) {
      throw new Error(`Caplet ${capletId} has no root object`);
    }

    return this.#getVatRoot(caplet.rootKref);
  }
}
harden(CapletController);
