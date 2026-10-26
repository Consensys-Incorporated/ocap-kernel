/* oxlint-disable node/no-process-env -- testing env var behavior */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getOcapHome } from './ocap-home.ts';

describe('getOcapHome', () => {
  const originalOcapHome = process.env.OCAP_HOME;

  afterEach(() => {
    if (originalOcapHome === undefined) {
      delete process.env.OCAP_HOME;
    } else {
      process.env.OCAP_HOME = originalOcapHome;
    }
  });

  it('returns OCAP_HOME when set', () => {
    process.env.OCAP_HOME = '/custom/ocap/home';
    expect(getOcapHome()).toBe('/custom/ocap/home');
  });

  it('falls back to ~/.ocap when OCAP_HOME is unset', () => {
    delete process.env.OCAP_HOME;
    expect(getOcapHome()).toBe(join(homedir(), '.ocap'));
  });
});
