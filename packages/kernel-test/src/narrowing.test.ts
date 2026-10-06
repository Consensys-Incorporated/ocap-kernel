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

  it.each([
    { from: ['srv', 'data', 'x'], to: ['srv', 'data', 'y'] },
    { from: ['srv', 'logs', 'x'], to: ['srv', 'logs', 'y'] },
  ])(
    'joins multi-argument narrowings: copy($from, $to)',
    async ({ from, to }) => {
      const kernel = await launchNarrowingVat();
      expect(await probe(kernel, 'probeJoinedCopy', [from, to])).toBe(
        `ok:copy:${from.join('/')}->${to.join('/')}`,
      );
    },
  );

  it('rejects a call combining the arguments of two joined narrowings', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeJoinedCopy', [
        ['srv', 'data', 'x'],
        ['srv', 'logs', 'y'],
      ]),
    ).toMatch(/^rejected:.*\bcopy\b/u);
  });

  it.each([
    {
      scenario: 'admits a call within one operand',
      to: ['srv', 'logs', 'y'],
      from: ['srv', 'logs', 'x'],
      expected: /^ok:copy:srv\/logs\/x->srv\/logs\/y$/u,
    },
    {
      scenario: 'rejects a call the narrowing excludes',
      from: ['srv', 'logs', 'x'],
      to: ['srv', 'logs', 'secret'],
      expected: /^rejected:.*\bcopy\b/u,
    },
    {
      scenario: 'rejects the cross-combination',
      from: ['srv', 'data', 'x'],
      to: ['srv', 'logs', 'y'],
      expected: /^rejected:.*\bcopy\b/u,
    },
  ])('narrows a join: $scenario', async ({ from, to, expected }) => {
    const kernel = await launchNarrowingVat();
    expect(await probe(kernel, 'probeNarrowedJoin', [from, to])).toMatch(
      expected,
    );
  });

  it('flattens a narrowed join onto the original base', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeNarrowedJoinWithBase', [
        ['srv', 'data', 'x'],
        ['srv', 'logs', 'secret'],
      ]),
    ).toBe('ok:copy:srv/data/x->srv/logs/secret');
  });

  it('narrows a default-guarded exo', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeDefaultGuarded', [['srv', 'data', 'x']]),
    ).toBe('ok:loose:srv/data/x');
  });
});
