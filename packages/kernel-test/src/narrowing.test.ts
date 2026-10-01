import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { kunser } from '@metamask/ocap-kernel';
import type { Kernel, KRef, VatConfig } from '@metamask/ocap-kernel';
import { describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

const V1_ROOT: KRef = 'ko4';

/**
 * Launch the narrowing vat.
 *
 * @returns The running kernel.
 */
const launchNarrowingVat = async (): Promise<Kernel> => {
  const { logger } = makeTestLogger();
  const database = await makeSQLKernelDatabase({});
  const kernel = await makeKernel(database, true, logger);
  const vat: VatConfig = {
    bundleSpec: getBundleSpec('narrowing-vat'),
    parameters: {},
  };
  await kernel.launchSubcluster({ bootstrap: 'main', vats: { main: vat } });
  await waitUntilQuiescent();
  return kernel;
};

/**
 * Invoke one of the vat's probes.
 *
 * @param kernel - The kernel to send through.
 * @param method - The probe to invoke.
 * @param args - The probe's arguments.
 * @returns `ok:<result>` or `rejected:<message>`, per the vat.
 */
const probe = async (
  kernel: Kernel,
  method: string,
  args: unknown[],
): Promise<unknown> => kunser(await kernel.queueMessage(V1_ROOT, method, args));

describe('narrowing', () => {
  it('narrows a vat-local exo', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeNarrowed', ['read', ['srv', 'data', 'x']]),
    ).toBe('ok:read:srv/data/x');
  });

  it('rejects a call outside the narrowing', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeNarrowed', ['read', ['etc', 'passwd']]),
    ).toMatch(/^rejected:.*\bread\b/u);
  });

  it('drops methods absent from the delta', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeNarrowed', ['stat', ['srv', 'data', 'x']]),
    ).toMatch(/^rejected:.*\bstat\b/u);
  });

  it('joins two narrowings of a common base', async () => {
    const kernel = await launchNarrowingVat();
    expect(await probe(kernel, 'probeJoined', [['srv', 'logs', 'y']])).toBe(
      'ok:read:srv/logs/y',
    );
  });

  it('narrows a default-guarded exo', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeDefaultGuarded', [['srv', 'data', 'x']]),
    ).toBe('ok:loose:srv/data/x');
  });
});
