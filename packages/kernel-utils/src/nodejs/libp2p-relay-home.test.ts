/* oxlint-disable node/no-process-env -- testing env var behavior */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getLibp2pRelayHome } from './libp2p-relay-home.ts';

describe('getLibp2pRelayHome', () => {
  const original = process.env.LIBP2P_RELAY_HOME;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LIBP2P_RELAY_HOME;
    } else {
      process.env.LIBP2P_RELAY_HOME = original;
    }
  });

  it('returns LIBP2P_RELAY_HOME when set', () => {
    process.env.LIBP2P_RELAY_HOME = '/custom/relay/home';
    expect(getLibp2pRelayHome()).toBe('/custom/relay/home');
  });

  it('falls back to ~/.libp2p-relay when LIBP2P_RELAY_HOME is unset', () => {
    delete process.env.LIBP2P_RELAY_HOME;
    expect(getLibp2pRelayHome()).toBe(join(homedir(), '.libp2p-relay'));
  });
});
