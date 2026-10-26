/**
 * Ocap JSON-RPC vat.
 *
 * Serves a line-delimited JSON-RPC 2.0 interface on a Unix-domain-socket
 * `IOListener` endowment named `socket`. External processes connect and
 * call `redeemURL(url)` and `send(target, method, args)` — see the
 * package README for the wire protocol.
 *
 * Each connection is served independently, with its own bridge and
 * therefore its own `@@j<n>` name table. Two clients can be connected at
 * once without either being able to name the other's references: the
 * names are closure state of one connection's serve loop, so a forged
 * name simply misses that client's own table. Since those names cross a
 * non-ocap boundary as plain forgeable strings, per-connection scoping is
 * what keeps them from conveying authority they were never granted.
 *
 * The vat's authority is exactly:
 *   - the `ocapURLRedemptionService` endowment (for `redeemURL`),
 *   - whatever references the URLs happen to redeem to,
 *   - and whatever those references introduce as return values.
 *
 * The vat has no other public facet: the socket is the sole interface.
 */

import { E } from '@endo/eventual-send';
import { passStyleOf } from '@endo/pass-style';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage, OcapURLRedemptionService } from '@metamask/ocap-kernel';

import { makeBridge } from '../bridge.ts';
import { BridgeRpcError, JSON_RPC_ERROR } from '../json-rpc.ts';
import type { JsonRpcResponse } from '../json-rpc.ts';

/**
 * The vat-facing shape of one accepted connection. The kernel-side
 * implementation lives in `packages/ocap-kernel/src/io/io-service.ts`.
 */
type IOConnection = {
  read: () => Promise<string | null>;
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * The vat-facing shape of an `IOListener`. `accept()` resolves to the next
 * peer's connection, or `null` once the listener has been closed. Wired
 * via the cluster config's `io` block.
 */
type IOListener = {
  accept: () => Promise<IOConnection | null>;
};

type Services = {
  ocapURLRedemptionService: OcapURLRedemptionService;
  socket: IOListener;
};

/**
 * Build the vat's root object.
 *
 * The `@@j<n>` name table lives in ordinary closure state and is
 * intentionally non-durable — each re-incarnation begins with an
 * empty table. The services endowments delivered to `bootstrap` are
 * stashed in baggage so that on re-incarnation `buildRootObject` can
 * restart the socket serve loop without bootstrap having to run
 * again (bootstrap only runs once per subcluster lifetime, not on
 * every daemon restart).
 *
 * @param _vatPowers - Unused.
 * @param _parameters - Unused.
 * @param baggage - Vat baggage. Used to persist the services endowment
 * bag so the serve loop can be resumed on re-incarnation.
 * @returns The vat root exo.
 */
export function buildRootObject(
  _vatPowers: unknown,
  _parameters: unknown,
  baggage: Baggage,
): unknown {
  const log = (...args: unknown[]): void => {
    // oxlint-disable-next-line no-console
    console.log('[ocap-jsonrpc-vat]', ...args);
  };

  const isRemotable = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    try {
      const style: string = passStyleOf(value as never);
      return style === 'remotable';
    } catch {
      return false;
    }
  };

  /**
   * Read one request line, dispatch it, and write the response. Never
   * throws to its caller — decoding, dispatch, and encoding errors are
   * either logged and swallowed (when we can't recover an id to reply
   * on) or packaged as JSON-RPC error responses.
   *
   * @param connection - The connection to serve.
   * @param dispatch - The bridge's dispatch function.
   * @returns 'ok' after processing a request, and 'closed' once the peer
   * has gone away or the connection failed.
   */
  async function processOne(
    connection: IOConnection,
    dispatch: (request: unknown) => Promise<JsonRpcResponse>,
  ): Promise<'ok' | 'closed'> {
    let line: string | null;
    try {
      line = await E(connection).read();
    } catch (error) {
      log('connection read failed:', error);
      return 'closed';
    }
    if (line === null) {
      return 'closed';
    }
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch (error) {
      // Reply rather than dropping: this is a request/reply socket, so a
      // client awaiting an answer would otherwise wait forever. The id is
      // unknowable from an unparseable line, which is exactly the case
      // JSON-RPC 2.0 covers with a null id.
      log('failed to parse request line as JSON:', error);
      return await respond(connection, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR.PARSE_ERROR,
          message: 'request line is not valid JSON',
        },
      });
    }
    return await respond(connection, await dispatch(request));
  }

  /**
   * Encode and write one response.
   *
   * The encode guard here is now defensive rather than load-bearing: a
   * response from `dispatch` has already been proven encodable, because the
   * bridge has to know whether the reply is sendable before it commits the
   * `@@j<n>` names minted for it. This still covers the responses built
   * directly in this module, and keeps a `JSON.stringify` throw from being
   * reported as a write failure, which would drop the connection and leave
   * the client waiting instead of answering it.
   *
   * @param connection - The connection to write to.
   * @param response - The response to encode and send.
   * @returns 'ok' if the response was written, 'closed' if the connection
   * could not be written to.
   */
  async function respond(
    connection: IOConnection,
    response: JsonRpcResponse,
  ): Promise<'ok' | 'closed'> {
    let encoded: string;
    try {
      encoded = JSON.stringify(response);
    } catch (error) {
      log('failed to encode response:', error);
      encoded = JSON.stringify({
        jsonrpc: '2.0',
        id: response.id,
        error: {
          code: JSON_RPC_ERROR.INTERNAL_ERROR,
          message: 'result could not be encoded as JSON',
        },
      });
    }
    try {
      await E(connection).write(encoded);
    } catch (error) {
      log('failed to write response:', error);
      return 'closed';
    }
    return 'ok';
  }

  /**
   * Serve one connection for its whole lifetime, with a bridge — and so a
   * name table — belonging to it alone. Returns when the peer goes away.
   *
   * @param services - The endowments delivered by bootstrap.
   * @param connection - The connection to serve.
   * @param label - Diagnostic label identifying this connection in logs.
   */
  async function serveConnection(
    services: Services,
    connection: IOConnection,
    label: string,
  ): Promise<void> {
    const bridge = makeBridge({
      redeem: async (url) => E(services.ocapURLRedemptionService).redeem(url),
      invoke: async (target, method, args) =>
        // oxlint-disable-next-line typescript/no-explicit-any
        E(target as any)[method](...args),
      isRemotable,
      label,
    });
    try {
      for (;;) {
        const outcome = await processOne(connection, bridge.dispatch);
        if (outcome === 'closed') {
          log(`${label}: peer disconnected`);
          return;
        }
      }
    } finally {
      // Discard this connection's names and let the kernel stop hosting
      // it. Nothing else referenced them, so the table dies with the
      // connection rather than leaking into whoever connects next.
      bridge.resetSession();
      try {
        await E(connection).close();
      } catch (error) {
        log(`${label}: error closing connection:`, error);
      }
    }
  }

  /**
   * Accept connections forever, serving each one concurrently. A peer
   * that stalls or floods only affects its own serve loop.
   *
   * @param services - The endowments delivered by bootstrap.
   */
  async function acceptLoop(services: Services): Promise<void> {
    let acceptedCount = 0;
    for (;;) {
      let connection: IOConnection | null;
      try {
        connection = await E(services.socket).accept();
      } catch (error) {
        log('accept failed; ending accept loop:', error);
        return;
      }
      if (!connection) {
        log('listener closed; ending accept loop');
        return;
      }
      acceptedCount += 1;
      const label = `connection ${acceptedCount}`;
      log(`${label}: accepted`);
      // Deliberately not awaited: serving must not block accepting, or a
      // single long-lived client would keep everyone else out — which is
      // the failure the listener split exists to prevent.
      serveConnection(services, connection, label).catch((error) =>
        log(`${label}: serve loop crashed:`, error),
      );
    }
  }

  /**
   * Kick off the accept loop as a background task. Any crash inside it is
   * logged; the vat itself remains alive so it can be introspected.
   *
   * @param services - The endowments to serve against.
   */
  const startAcceptLoop = (services: Services): void => {
    acceptLoop(services).catch((error) => log('accept loop crashed:', error));
  };

  // On re-incarnation (e.g. after `daemon stop`/`daemon start`),
  // bootstrap is not re-run — but this `buildRootObject` is. Read the
  // previously-stashed services out of baggage and resume accepting.
  //
  // Only the listener reference has to survive, and it does: the kernel
  // re-creates the listener under the same service kref before the vats
  // are re-incarnated, so the baggage-held Presence is live again. The
  // connections from the previous incarnation are gone, which is correct
  // — a socket does not outlive the process on the other end of it.
  //
  // Deferred to a microtask so vat init completes and the vat is fully
  // connected to kernel dispatch before we start issuing E() calls.
  if (baggage.has('services')) {
    const restored = baggage.get('services') as Services;
    Promise.resolve()
      .then(() => {
        startAcceptLoop(restored);
        log('vat re-incarnated; accept loop resumed');
        return undefined;
      })
      .catch((error) =>
        log('failed to resume accept loop on re-incarnation:', error),
      );
  }

  return makeDefaultExo('ocapJsonrpcVatRoot', {
    async bootstrap(_vats: Record<string, unknown>, incoming: Services) {
      if (!incoming?.ocapURLRedemptionService) {
        throw new BridgeRpcError(
          JSON_RPC_ERROR.INTERNAL_ERROR,
          'ocapURLRedemptionService is required',
        );
      }
      if (!incoming.socket) {
        throw new BridgeRpcError(
          JSON_RPC_ERROR.INTERNAL_ERROR,
          'socket IOListener is required (configure it in the cluster config under `io.socket`)',
        );
      }
      if (baggage.has('services')) {
        baggage.set('services', incoming);
      } else {
        baggage.init('services', incoming);
      }
      startAcceptLoop(incoming);
      log('vat bootstrap complete');
      return harden({});
    },
  });
}
