import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { kunser } from '@metamask/ocap-kernel';
import type { Kernel, KRef, VatConfig } from '@metamask/ocap-kernel';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

const V1_ROOT: KRef = 'ko4';

/**
 * Launch the narrowing vat.
 *
 * @param platformConfig - Platform capabilities to grant the vat, if any.
 * @returns The running kernel.
 */
const launchNarrowingVat = async (
  platformConfig?: VatConfig['platformConfig'],
): Promise<Kernel> => {
  const { logger } = makeTestLogger();
  const database = await makeSQLKernelDatabase({});
  const kernel = await makeKernel(database, true, logger);
  const vat: VatConfig = {
    bundleSpec: getBundleSpec('narrowing-vat'),
    parameters: {},
    ...(platformConfig && { platformConfig }),
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

/**
 * Create a readable file two directories deep, so that a narrowing of the
 * directory holding it is strictly narrower than the configured root, and a
 * directory symlink inside the root leading out of it.
 *
 * @returns Absolute segment arrays for the tree, and the file's byte length.
 */
const makeTempTree = async (): Promise<{
  root: string[];
  inner: string[];
  file: string[];
  sibling: string[];
  throughLink: string[];
  size: number;
}> => {
  const contents = 'narrowed-fs\n';
  // `realpath` because the capability refuses a path through a symlink, and
  // the temporary directory is under one on macOS.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'narrowing-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'outside-')));
  await writeFile(join(outside, 'secret.txt'), contents);
  await mkdir(join(dir, 'inner'));
  await writeFile(join(dir, 'inner', 'hello.txt'), contents);
  await writeFile(join(dir, 'sibling.txt'), contents);
  await symlink(outside, join(dir, 'inner', 'link'));
  const root = dir.split(sep).filter(Boolean);
  return {
    root,
    inner: [...root, 'inner'],
    file: [...root, 'inner', 'hello.txt'],
    sibling: [...root, 'sibling.txt'],
    throughLink: [...root, 'inner', 'link', 'secret.txt'],
    size: contents.length,
  };
};

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

  it.each([
    { segments: ['srv', 'data', 'x'], expected: /^ok:read:srv\/data\/x$/u },
    { segments: ['srv', 'logs', 'y'], expected: /^ok:read:srv\/logs\/y$/u },
    { segments: ['srv', 'data', 'secret'], expected: /^rejected:.*\bread\b/u },
  ])(
    'flattens and joins narrowings given as promises: read($segments)',
    async ({ segments, expected }) => {
      const kernel = await launchNarrowingVat();
      expect(await probe(kernel, 'probeNarrowedPromise', [segments])).toMatch(
        expected,
      );
    },
  );

  it('narrows a default-guarded exo', async () => {
    const kernel = await launchNarrowingVat();
    expect(
      await probe(kernel, 'probeDefaultGuarded', [['srv', 'data', 'x']]),
    ).toBe('ok:loose:srv/data/x');
  });

  it('receives fs as an exo', async () => {
    const { root, file, size } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(await probe(kernel, 'probeFs', [file])).toBe(`ok:${size}`);
  });

  it('scopes fs by config', async () => {
    const { root, file, size } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(await probe(kernel, 'probeFs', [file])).toBe(`ok:${size}`);
    expect(await probe(kernel, 'probeFs', [['etc', 'passwd']])).toMatch(
      /^rejected:/u,
    );
  });

  // `pathUnder` matches the root's positions and cannot see inside a segment,
  // so this satisfies the config's pattern and is refused by the capability's
  // own well-formedness check, which the narrowing inherits by forwarding.
  it('rejects a separator inside a segment the config pattern admits', async () => {
    const { root } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(
      await probe(kernel, 'probeFs', [[...root, 'x/../../etc/passwd']]),
    ).toMatch(/^rejected:.*invalid segment/u);
  });

  it('narrows the config-scoped fs further', async () => {
    const { root, inner, file, sibling, size } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(await probe(kernel, 'probeFsNarrowed', [inner, file])).toBe(
      `ok:${size}`,
    );
    expect(await probe(kernel, 'probeFsNarrowed', [inner, sibling])).toMatch(
      /^rejected:/u,
    );
  });

  it('rejects a path through a directory symlink inside the root', async () => {
    const { root, throughLink } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(await probe(kernel, 'probeFs', [throughLink])).toMatch(
      /^rejected:.*not canonical/u,
    );
  });

  it('rejects a path through a directory symlink inside a narrowing', async () => {
    const { root, inner, throughLink } = await makeTempTree();
    const kernel = await launchNarrowingVat({
      fs: { root, methods: ['readFile'] },
    });
    expect(
      await probe(kernel, 'probeFsNarrowed', [inner, throughLink]),
    ).toMatch(/^rejected:.*not canonical/u);
  });
});
