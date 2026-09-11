import type { PlatformFactory } from '@metamask/kernel-platforms';
import { delay, isJsonRpcMessage } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { rpcErrors } from '@metamask/rpc-errors';
import { TestDuplexStream } from '@ocap/repo-tools/test-utils/streams';
import { describe, it, expect, vi } from 'vitest';

import type { VatEndowments } from './endowments.ts';
import { VatSupervisor } from './VatSupervisor.ts';
import type { FetchBlob } from './VatSupervisor.ts';

vi.mock('./syscall.ts', () => ({
  makeSupervisorSyscall: vi.fn(() => ({
    vatstoreGet: vi.fn(),
    vatstoreSet: vi.fn(),
  })),
}));

vi.mock('@agoric/swingset-liveslots', () => ({
  makeLiveSlots: vi.fn(() => ({
    dispatch: vi.fn(),
    makeVat: vi.fn(),
  })),
}));

const makeVatEndowments = (
  globals: Record<string, unknown>,
  teardown: () => Promise<void> = async () => undefined,
): VatEndowments => ({
  globals: harden({ ...globals }),
  teardown,
});

const makeVatSupervisor = async ({
  dispatch,
  logger,
  vatPowers,
  makePlatform,
  platformOptions,
  makeAllowedGlobals,
  fetchBlob,
  writerOnEnd,
}: {
  dispatch?: (input: unknown) => void | Promise<void>;
  logger?: Logger;
  vatPowers?: Record<string, unknown>;
  makePlatform?: PlatformFactory;
  platformOptions?: Record<string, unknown>;
  makeAllowedGlobals?: (options: { logger: Logger }) => VatEndowments;
  fetchBlob?: FetchBlob;
  writerOnEnd?: () => void;
} = {}): Promise<{
  supervisor: VatSupervisor;
  stream: TestDuplexStream<JsonRpcMessage, JsonRpcMessage>;
}> => {
  const kernelStream = await TestDuplexStream.make<
    JsonRpcMessage,
    JsonRpcMessage
  >(dispatch ?? (() => undefined), {
    validateInput: isJsonRpcMessage,
    writerOnEnd,
  });

  // Provide a default makePlatform if none is specified
  const defaultMakePlatform: PlatformFactory = vi.fn().mockResolvedValue({});

  return {
    supervisor: new VatSupervisor({
      id: 'test-id',
      kernelStream,
      logger: logger ?? new Logger(),
      vatPowers: vatPowers ?? {},
      makePlatform: makePlatform ?? defaultMakePlatform,
      platformOptions: platformOptions ?? {},
      makeAllowedGlobals,
      fetchBlob,
    }),
    stream: kernelStream,
  };
};

describe('VatSupervisor', () => {
  describe('init', () => {
    it('initializes the VatSupervisor correctly', async () => {
      const { supervisor } = await makeVatSupervisor();
      expect(supervisor).toBeInstanceOf(VatSupervisor);
      expect(supervisor.id).toBe('test-id');
    });

    it('throws if the stream throws', async () => {
      const logger = {
        error: vi.fn(),
        subLogger: vi.fn(() => logger),
      } as unknown as Logger;
      const { supervisor, stream } = await makeVatSupervisor({ logger });
      await stream.receiveInput(NaN);
      await delay(10);
      expect(logger.error).toHaveBeenCalledWith(
        `Unexpected read error from VatSupervisor "${supervisor.id}"`,
        expect.any(Error),
      );
    });
  });

  describe('handleMessage', () => {
    it('responds with an error for unknown methods', async () => {
      const dispatch = vi.fn();
      const { stream } = await makeVatSupervisor({ dispatch });

      await stream.receiveInput({
        id: 'v0:0',
        method: 'bogus',
        params: [],
        jsonrpc: '2.0',
      });
      await delay(10);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'v0:0',
          error: expect.objectContaining({
            code: rpcErrors.methodNotFound().code,
          }),
        }),
      );
    });

    it('handles "ping" requests', async () => {
      const dispatch = vi.fn();
      const { stream } = await makeVatSupervisor({ dispatch });

      await stream.receiveInput({
        id: 'v0:0',
        method: 'ping',
        params: [],
        jsonrpc: '2.0',
      });
      await delay(10);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'v0:0',
          result: 'pong',
        }),
      );
    });
  });

  describe('terminate', () => {
    it('terminates correctly', async () => {
      const { supervisor, stream } = await makeVatSupervisor();

      await supervisor.terminate();
      expect(await stream.next()).toStrictEqual({
        done: true,
        value: undefined,
      });
    });

    it('calls the endowments teardown before closing the stream', async () => {
      // The stream is hardened, so we can't vi.spyOn(stream, 'end'). Instead,
      // observe the writer's onEnd callback, which fires as part of stream.end().
      const teardown = vi.fn().mockResolvedValue(undefined);
      const writerOnEnd = vi.fn();
      const { supervisor } = await makeVatSupervisor({
        makeAllowedGlobals: () => makeVatEndowments({}, teardown),
        writerOnEnd,
      });

      await supervisor.terminate();

      expect(teardown).toHaveBeenCalledTimes(1);
      expect(writerOnEnd).toHaveBeenCalledTimes(1);
      expect(teardown.mock.invocationCallOrder[0]).toBeLessThan(
        writerOnEnd.mock.invocationCallOrder[0] as number,
      );
    });

    it('closes the stream and logs when teardown rejects', async () => {
      const logger = {
        error: vi.fn(),
        subLogger: vi.fn(() => logger),
      } as unknown as Logger;
      const teardownError = new Error('boom');
      const { supervisor, stream } = await makeVatSupervisor({
        logger,
        makeAllowedGlobals: () =>
          makeVatEndowments({}, async () => {
            throw teardownError;
          }),
      });

      await supervisor.terminate();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Endowment teardown failed'),
        teardownError,
      );
      expect(await stream.next()).toStrictEqual({
        done: true,
        value: undefined,
      });
    });

    it('is safe to call twice and runs teardown only once', async () => {
      const teardown = vi.fn().mockResolvedValue(undefined);
      const { supervisor } = await makeVatSupervisor({
        makeAllowedGlobals: () => makeVatEndowments({}, teardown),
      });

      await supervisor.terminate();
      expect(await supervisor.terminate()).toBeUndefined();
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('logs each sub-error when teardown rejects with an AggregateError', async () => {
      const logger = {
        error: vi.fn(),
        subLogger: vi.fn(() => logger),
      } as unknown as Logger;
      const subErrorA = new Error('timer teardown failed');
      const subErrorB = new Error('network teardown failed');
      const { supervisor, stream } = await makeVatSupervisor({
        logger,
        makeAllowedGlobals: () =>
          makeVatEndowments({}, async () => {
            throw new AggregateError(
              [subErrorA, subErrorB],
              'Endowment teardown failed (2/2)',
            );
          }),
      });

      await supervisor.terminate();

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('Endowment teardown failed'),
        subErrorA,
      );
      expect(logger.error).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('Endowment teardown failed'),
        subErrorB,
      );
      expect(await stream.next()).toStrictEqual({
        done: true,
        value: undefined,
      });
    });
  });

  describe('platform configuration', () => {
    it('accepts makePlatform and platformOptions parameters', async () => {
      const makePlatform = vi.fn().mockResolvedValue({});
      const platformOptions = { fs: { root: ['tmp'] } };

      const { supervisor } = await makeVatSupervisor({
        makePlatform,
        platformOptions,
      });

      expect(supervisor).toBeInstanceOf(VatSupervisor);
      expect(supervisor.id).toBe('test-id');
    });

    it('provides default platformOptions when not specified', async () => {
      const makePlatform = vi.fn().mockResolvedValue({});

      const { supervisor } = await makeVatSupervisor({
        makePlatform,
        // platformOptions omitted
      });

      expect(supervisor).toBeInstanceOf(VatSupervisor);
    });
  });

  describe('makeAllowedGlobals configuration', () => {
    it('invokes the factory exactly once at construction', async () => {
      const factory = vi.fn(() =>
        makeVatEndowments({ CustomGlobal: 'custom-value' }),
      );
      const { supervisor } = await makeVatSupervisor({
        makeAllowedGlobals: factory,
      });
      expect(supervisor).toBeInstanceOf(VatSupervisor);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('rejects fetch requests without network.allowedHosts', async () => {
      const dispatch = vi.fn();
      const mockFetchBlob: FetchBlob = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(''),
      });

      // Use a plain function, not vi.fn(), since `makeVatEndowments`
      // hardens the globals record transitively — a vi.fn() here would
      // freeze the mock's internals and break unrelated tests that mock-reset
      // afterwards.
      const stubFetch = (() => undefined) as unknown as typeof fetch;
      const { stream } = await makeVatSupervisor({
        dispatch,
        makeAllowedGlobals: () => makeVatEndowments({ fetch: stubFetch }),
        fetchBlob: mockFetchBlob,
      });

      await stream.receiveInput({
        id: 'test-init',
        method: 'initVat',
        params: {
          vatConfig: {
            bundleSpec: 'test.bundle',
            parameters: {},
            globals: ['fetch'],
          },
          state: [],
        },
        jsonrpc: '2.0',
      });
      await delay(50);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-init',
          error: expect.objectContaining({
            message: expect.stringContaining(
              'requested "fetch" but no network.allowedHosts',
            ),
          }),
        }),
      );
    });

    it('proceeds past the fetch-allowlist guard when network.allowedHosts is supplied', async () => {
      // If the guard mis-fires, dispatch would receive the specific
      // 'requested "fetch" but no network.allowedHosts' error. Asserting
      // its absence proves the caveat wrap ran and init moved on (any
      // later error, e.g., bundle load, is acceptable).
      const dispatch = vi.fn();
      const mockFetchBlob: FetchBlob = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(''),
      });

      const stubFetch = (() => undefined) as unknown as typeof fetch;
      const { stream } = await makeVatSupervisor({
        dispatch,
        makeAllowedGlobals: () => makeVatEndowments({ fetch: stubFetch }),
        fetchBlob: mockFetchBlob,
      });

      await stream.receiveInput({
        id: 'test-init',
        method: 'initVat',
        params: {
          vatConfig: {
            bundleSpec: 'test.bundle',
            parameters: {},
            globals: ['fetch'],
            network: { allowedHosts: ['example.test'] },
          },
          state: [],
        },
        jsonrpc: '2.0',
      });
      await delay(50);

      // With makeLiveSlots mocked, init completes and dispatch receives
      // the delivery result — assert that positive shape directly so the
      // test doesn't pass vacuously if init were to short-circuit.
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-init',
          result: expect.anything(),
        }),
      );
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-init',
          error: expect.objectContaining({
            message: expect.stringMatching(
              /requested "fetch" but no network\.allowedHosts/u,
            ),
          }),
        }),
      );
    });

    it('rejects an unknown global at the initVat RPC boundary', async () => {
      // VatConfig.globals is now typed as AllowedGlobalName[] and validated by
      // AllowedGlobalNameStruct at the RPC boundary, so an unknown name is
      // rejected before reaching the VatSupervisor's per-name check.
      const dispatch = vi.fn();

      const mockFetchBlob: FetchBlob = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(''),
      });

      const { stream } = await makeVatSupervisor({
        dispatch,
        makeAllowedGlobals: () => makeVatEndowments({ Date: globalThis.Date }),
        fetchBlob: mockFetchBlob,
      });

      await stream.receiveInput({
        id: 'test-init',
        method: 'initVat',
        params: {
          vatConfig: {
            bundleSpec: 'test.bundle',
            parameters: {},
            globals: ['Date', 'UnknownThing'],
          },
          state: [],
        },
        jsonrpc: '2.0',
      });
      await delay(50);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-init',
          error: expect.objectContaining({
            message: expect.stringContaining('Invalid params'),
          }),
        }),
      );
    });
  });
});
