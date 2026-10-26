import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Get the libp2p relay's bookkeeping directory. This is where the relay
 * writes its PID file and multiaddr file, and where the daemon's
 * `--local-relay` mode reads them. It is intentionally separate from
 * `OCAP_HOME`: a single libp2p relay serves any number of OCAP daemons
 * on the same host, regardless of which `OCAP_HOME` each daemon uses.
 *
 * Defaults to `~/.libp2p-relay`; overridable with `LIBP2P_RELAY_HOME`.
 *
 * @returns The absolute path to the libp2p relay state directory.
 */
export function getLibp2pRelayHome(): string {
  // oxlint-disable-next-line node/no-process-env
  return process.env.LIBP2P_RELAY_HOME ?? join(homedir(), '.libp2p-relay');
}
