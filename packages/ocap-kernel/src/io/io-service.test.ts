import { describe, it, expect, vi } from 'vitest';

import {
  makeIOConnectionService,
  makeIOListenerService,
} from './io-service.ts';
import type { ConnectionHost } from './io-service.ts';
import type { IOChannel, IOListener } from './types.ts';
import { krefOf } from '../liveslots/kernel-marshal.ts';
import type { SlotValue } from '../liveslots/kernel-marshal.ts';
import type { IOConfig, KRef } from '../types.ts';

type ConnectionFacet = {
  read: () => Promise<string | null>;
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

type ListenerFacet = {
  accept: () => Promise<unknown>;
  close: () => Promise<void>;
};

const makeChannel = (): IOChannel => ({
  read: vi.fn().mockResolvedValue('hello'),
  write: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

const makeConfig = (overrides: Partial<IOConfig> = {}): IOConfig =>
  ({
    type: 'socket',
    path: '/tmp/test.sock',
    ...overrides,
  }) as IOConfig;

/**
 * Build a listener that hands out the supplied channels in order, then
 * reports EOF by resolving `null`.
 *
 * @param channels - The channels to yield from successive `accept()` calls.
 * @returns The listener plus its close spy.
 */
function makeListener(channels: IOChannel[]): IOListener {
  const queue = [...channels];
  return {
    accept: vi.fn().mockImplementation(async () => queue.shift() ?? null),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a connection host that allocates sequential fake krefs and records
 * what was registered and released.
 *
 * @returns The host plus its bookkeeping.
 */
function makeHost(): ConnectionHost & {
  registered: { kref: KRef; label: string; connection: object }[];
  released: KRef[];
} {
  const registered: { kref: KRef; label: string; connection: object }[] = [];
  const released: KRef[] = [];
  let next = 0;
  return {
    registered,
    released,
    register: async (connection: object, label: string): Promise<KRef> => {
      next += 1;
      const kref = `ko${next}` as KRef;
      registered.push({ kref, label, connection });
      return kref;
    },
    release: async (kref: KRef): Promise<void> => {
      released.push(kref);
    },
  };
}

describe('makeIOConnectionService', () => {
  describe('read()', () => {
    it('delegates to the channel', async () => {
      const channel = makeChannel();
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        channel,
        makeConfig(),
        vi.fn(),
      ) as ConnectionFacet;

      expect(await connection.read()).toBe('hello');
      expect(channel.read).toHaveBeenCalledOnce();
    });

    it('throws on a write-only connection', async () => {
      const channel = makeChannel();
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        channel,
        makeConfig({ direction: 'out' }),
        vi.fn(),
      ) as ConnectionFacet;

      await expect(connection.read()).rejects.toThrow(
        'IO connection "io:subclusterFoo:test:c1" is write-only',
      );
      expect(channel.read).not.toHaveBeenCalled();
    });

    it.each(['in', 'inout'] as const)(
      'allows read on direction=%s',
      async (direction) => {
        const connection = makeIOConnectionService(
          'io:subclusterFoo:test:c1',
          makeChannel(),
          makeConfig({ direction }),
          vi.fn(),
        ) as ConnectionFacet;

        expect(await connection.read()).toBe('hello');
      },
    );
  });

  describe('write()', () => {
    it('delegates to the channel', async () => {
      const channel = makeChannel();
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        channel,
        makeConfig(),
        vi.fn(),
      ) as ConnectionFacet;

      await connection.write('world');

      expect(channel.write).toHaveBeenCalledWith('world');
    });

    it('throws on a read-only connection', async () => {
      const channel = makeChannel();
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        channel,
        makeConfig({ direction: 'in' }),
        vi.fn(),
      ) as ConnectionFacet;

      await expect(connection.write('data')).rejects.toThrow(
        'IO connection "io:subclusterFoo:test:c1" is read-only',
      );
      expect(channel.write).not.toHaveBeenCalled();
    });

    it.each(['out', 'inout'] as const)(
      'allows write on direction=%s',
      async (direction) => {
        const connection = makeIOConnectionService(
          'io:subclusterFoo:test:c1',
          makeChannel(),
          makeConfig({ direction }),
          vi.fn(),
        ) as ConnectionFacet;

        expect(await connection.write('data')).toBeUndefined();
      },
    );
  });

  describe('close()', () => {
    it('closes the channel and notifies the host', async () => {
      const channel = makeChannel();
      const onClose = vi.fn();
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        channel,
        makeConfig(),
        onClose,
      ) as ConnectionFacet;

      await connection.close();

      expect(channel.close).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('is idempotent', async () => {
      const channel = makeChannel();
      const onClose = vi.fn();
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        channel,
        makeConfig(),
        onClose,
      ) as ConnectionFacet;

      await connection.close();
      await connection.close();

      expect(channel.close).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('notifies the host even when the channel close fails', async () => {
      const channel = makeChannel();
      (channel.close as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('boom'),
      );
      const onClose = vi.fn();
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        channel,
        makeConfig(),
        onClose,
      ) as ConnectionFacet;

      await expect(connection.close()).rejects.toThrow('boom');
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe('direction defaults', () => {
    it('defaults to inout when direction is not specified', async () => {
      const connection = makeIOConnectionService(
        'io:subclusterFoo:test:c1',
        makeChannel(),
        makeConfig(),
        vi.fn(),
      ) as ConnectionFacet;

      expect(await connection.read()).toBe('hello');
      expect(await connection.write('data')).toBeUndefined();
    });
  });
});

describe('makeIOListenerService', () => {
  it('hosts each accepted connection and returns a reference to it', async () => {
    const channel = makeChannel();
    const host = makeHost();
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([channel]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    const result = await listener.accept();

    expect(host.registered).toHaveLength(1);
    expect(host.registered[0]?.label).toBe('io:s1:repl:c1');
    // The vat receives a reference, never a raw name it could forge.
    expect(krefOf(result as SlotValue)).toBe('ko1');
  });

  it('gives each connection a distinct identity', async () => {
    const host = makeHost();
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([makeChannel(), makeChannel()]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    const first = await listener.accept();
    const second = await listener.accept();

    expect(krefOf(first as SlotValue)).toBe('ko1');
    expect(krefOf(second as SlotValue)).toBe('ko2');
    expect(host.registered.map((entry) => entry.label)).toStrictEqual([
      'io:s1:repl:c1',
      'io:s1:repl:c2',
    ]);
  });

  it('isolates connections: each reads only its own channel', async () => {
    const first = makeChannel();
    const second = makeChannel();
    (first.read as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      'from-first',
    );
    (second.read as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      'from-second',
    );
    const host = makeHost();
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([first, second]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    await listener.accept();
    await listener.accept();

    const facets = host.registered.map(
      (entry) => entry.connection as unknown as ConnectionFacet,
    );
    expect(await facets[0]?.read()).toBe('from-first');
    expect(await facets[1]?.read()).toBe('from-second');
  });

  it('releases a connection from the host when it is closed', async () => {
    const host = makeHost();
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([makeChannel()]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    await listener.accept();
    const connection = host.registered[0]
      ?.connection as unknown as ConnectionFacet;
    await connection.close();

    expect(host.released).toStrictEqual(['ko1']);
  });

  it('returns null once the listener is exhausted', async () => {
    const host = makeHost();
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    expect(await listener.accept()).toBeNull();
    expect(host.registered).toHaveLength(0);
  });

  it('delegates close() to the listener', async () => {
    const underlying = makeListener([]);
    const listener = makeIOListenerService(
      'io:s1:repl',
      underlying,
      makeConfig(),
      makeHost(),
    ) as ListenerFacet;

    await listener.close();

    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('stops hosting outstanding connections when the listener closes', async () => {
    const host = makeHost();
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([makeChannel(), makeChannel()]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    await listener.accept();
    await listener.accept();
    // Neither connection was closed by its holder; closing the listener
    // must still release them, or their krefs stay pinned for the life of
    // the subcluster.
    await listener.close();

    expect(host.released).toStrictEqual(['ko1', 'ko2']);
  });

  it('closes a connection that could not be hosted', async () => {
    const channel = makeChannel();
    const host = makeHost();
    host.register = async () => {
      throw new Error('refused');
    };
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([channel]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    await expect(listener.accept()).rejects.toThrow('refused');
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('releases a connection hosted after the listener closed', async () => {
    const host = makeHost();
    const { register } = host;
    let finishRegistering = (): void => undefined;
    const registering = new Promise<void>((resolve) => {
      finishRegistering = resolve;
    });
    host.register = async (connection, label) => {
      await registering;
      return register(connection, label);
    };
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([makeChannel()]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    const accepted = listener.accept();
    await listener.close();
    finishRegistering();

    expect(await accepted).toBeNull();
    expect(host.released).toStrictEqual(['ko1']);
  });

  it.each(['connection', 'listener'] as const)(
    'settles a %s close() once the release has',
    async (closing) => {
      const host = makeHost();
      let finishReleasing = (): void => undefined;
      host.release = async () =>
        new Promise<void>((resolve) => {
          finishReleasing = resolve;
        });
      const listener = makeIOListenerService(
        'io:s1:repl',
        makeListener([makeChannel()]),
        makeConfig(),
        host,
      ) as ListenerFacet;
      await listener.accept();
      const closer =
        closing === 'listener'
          ? listener
          : (host.registered[0]?.connection as unknown as ConnectionFacet);

      let settled = false;
      const closed = closer.close().then(() => {
        settled = true;
        return undefined;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      finishReleasing();
      await closed;
    },
  );

  it('does not release a connection twice when it was already closed', async () => {
    const host = makeHost();
    const listener = makeIOListenerService(
      'io:s1:repl',
      makeListener([makeChannel(), makeChannel()]),
      makeConfig(),
      host,
    ) as ListenerFacet;

    await listener.accept();
    await listener.accept();
    const first = host.registered[0]?.connection as unknown as ConnectionFacet;
    await first.close();

    await listener.close();

    expect(host.released).toStrictEqual(['ko1', 'ko2']);
  });
});
