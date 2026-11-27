import { makeDefaultExo } from '@metamask/kernel-utils/exo';

import type { IOChannel, IOListener } from './types.ts';
import { kslot } from '../liveslots/kernel-marshal.ts';
import type { KRef } from '../types.ts';
import type { IOConfig } from '../types.ts';

/**
 * Hooks the listener service uses to host each accepted connection as a
 * kernel object reachable only by reference.
 */
export type ConnectionHost = {
  /** Host `connection`; resolves with its kref once the hosting is committed. */
  register: (connection: object, label: string) => Promise<KRef>;
  /** Release a hosted connection; resolves once the release is committed. */
  release: (kref: KRef) => Promise<void>;
};

/**
 * Create a kernel service exo wrapping an `IOChannel` for one accepted
 * connection.
 *
 * `direction` is enforced here rather than on the listener, since it is a
 * property of the data flow rather than of the point of contact.
 *
 * Lifetime: the holder must `close()` a connection when finished with it.
 * A peer disconnecting ends the underlying transport and makes `read()`
 * report EOF, but does *not* by itself stop the kernel hosting this
 * object, because the holder still has a live reference to it. Releasing
 * on EOF instead would be worse than leaking: the vat's c-list still names
 * the kref, so a subsequent call on the dropped reference would route to
 * `invokeKernelService` and find nothing registered, failing the caller
 * with `ENDPOINT_UNREACHABLE` for a connection it never released. Until a
 * vat dropping the reference is itself observable (see #1006), unreleased
 * connections are
 * bounded by their listener's lifetime: `close()` on the listener
 * releases whatever it handed out, and `IOManager` releases the rest when
 * the subcluster goes away.
 *
 * @param name - The scoped connection name, used as the exo's interface
 * name (e.g. `io:s1:repl:c3`).
 * @param channel - The channel for this connection.
 * @param config - The IO configuration for the owning listener.
 * @param onClose - Awaited after the channel closes, so the host can stop
 * hosting this connection.
 * @returns A remotable with `read()`, `write()`, and `close()`.
 */
export function makeIOConnectionService(
  name: string,
  channel: IOChannel,
  config: IOConfig,
  onClose: () => Promise<void>,
): object {
  const direction = config.direction ?? 'inout';
  let closed = false;

  return makeDefaultExo(name, {
    async read(): Promise<string | null> {
      if (direction === 'out') {
        throw new Error(`IO connection "${name}" is write-only`);
      }
      return channel.read();
    },

    async write(data: string): Promise<void> {
      if (direction === 'in') {
        throw new Error(`IO connection "${name}" is read-only`);
      }
      return channel.write(data);
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await channel.close();
      } finally {
        await onClose();
      }
    },
  });
}
harden(makeIOConnectionService);

/**
 * Create a kernel service exo that wraps an `IOListener`.
 *
 * `accept()` waits for the next peer, wraps that connection in its own exo,
 * hosts it as an anonymous kernel object, and returns a `kslot` standin so
 * the calling vat receives it as an ordinary Presence. Each connection is
 * therefore a distinct object with its own state, and holding one conveys
 * no access to any other.
 *
 * @param name - The scoped service name (e.g. `io:s1:repl`).
 * @param listener - The underlying listener to delegate to.
 * @param config - The IO configuration for this listener.
 * @param host - Hooks for hosting accepted connections as kernel objects.
 * @returns A remotable service object with `accept()` and `close()`.
 */
export function makeIOListenerService(
  name: string,
  listener: IOListener,
  config: IOConfig,
  host: ConnectionHost,
): object {
  let nextConnectionId = 0;
  /**
   * Krefs of connections handed out and not yet released, so closing the
   * listener stops hosting them too. Without this, closing a listener
   * dropped its sockets but left every accepted connection's kref pinned.
   */
  const hostedConnections = new Set<KRef>();
  let listenerClosed = false;

  return makeDefaultExo(name, {
    async accept(): Promise<unknown> {
      const channel = await listener.accept();
      if (!channel) {
        // Listener closed; report EOF rather than leaving the caller's
        // accept loop hanging forever.
        return null;
      }
      nextConnectionId += 1;
      const connectionName = `${name}:c${nextConnectionId}`;
      // Hosting needs the connection object, and the connection's close
      // handler needs the kref that hosting gives.
      let kref: KRef | undefined;
      const connection = makeIOConnectionService(
        connectionName,
        channel,
        config,
        async () => {
          if (kref) {
            hostedConnections.delete(kref);
            await host.release(kref);
          }
        },
      );
      try {
        kref = await host.register(connection, connectionName);
      } catch (error) {
        // Nobody will ever hold this connection to close it.
        await channel.close().catch(() => undefined);
        throw error;
      }
      if (listenerClosed) {
        // Closed while the registration was pending, so `close()` did not
        // see this connection to release it.
        await host.release(kref);
        return null;
      }
      hostedConnections.add(kref);
      return kslot(kref, connectionName);
    },

    async close(): Promise<void> {
      // Set first, so a registration that commits while the listener is
      // still closing is released by `accept()`.
      listenerClosed = true;
      await listener.close();
      const krefs = [...hostedConnections];
      hostedConnections.clear();
      await Promise.all(krefs.map(async (kref) => host.release(kref)));
    },
  });
}
harden(makeIOListenerService);
