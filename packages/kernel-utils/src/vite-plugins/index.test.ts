import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { VatBundle } from './bundle-vat.ts';
import { bundleVats } from './index.ts';

vi.mock('./bundle-vat.ts', () => ({
  bundleVat: vi.fn(),
}));

const mockBundle: VatBundle = {
  moduleFormat: 'iife',
  code: 'var __vatExports__ = {};',
  exports: ['default'],
  external: [],
};

type VatEntry = Parameters<typeof bundleVats>[0]['vats'][number];

describe('bundleVats', () => {
  const vats: [VatEntry, VatEntry] = [
    {
      source: '/absolute/path/to/echo-caplet.js',
      output: 'echo/echo-caplet.bundle',
    },
    { source: '/absolute/path/to/sample-vat.js', output: 'sample-vat.bundle' },
  ];

  beforeEach(async () => {
    const { bundleVat } = await import('./bundle-vat.ts');
    vi.mocked(bundleVat).mockResolvedValue(mockBundle);
  });

  it('registers vat sources for watch mode in buildStart', () => {
    const plugin = bundleVats({ vats });
    const context = { addWatchFile: vi.fn() };
    (plugin.buildStart as unknown as (this: typeof context) => void).call(
      context,
    );

    expect(context.addWatchFile).toHaveBeenCalledTimes(2);
    expect(context.addWatchFile).toHaveBeenCalledWith(vats[0].source);
    expect(context.addWatchFile).toHaveBeenCalledWith(vats[1].source);
  });

  it('bundles vats and emits assets in generateBundle', async () => {
    const { bundleVat } = await import('./bundle-vat.ts');
    const plugin = bundleVats({ vats });
    const context = { emitFile: vi.fn() };
    await (
      plugin.generateBundle as unknown as (
        this: typeof context,
      ) => Promise<void>
    ).call(context);

    expect(bundleVat).toHaveBeenCalledTimes(2);
    expect(bundleVat).toHaveBeenCalledWith(vats[0].source);
    expect(bundleVat).toHaveBeenCalledWith(vats[1].source);

    expect(context.emitFile).toHaveBeenCalledTimes(2);
    expect(context.emitFile).toHaveBeenCalledWith({
      type: 'asset',
      fileName: 'echo/echo-caplet.bundle',
      source: JSON.stringify(mockBundle),
    });
    expect(context.emitFile).toHaveBeenCalledWith({
      type: 'asset',
      fileName: 'sample-vat.bundle',
      source: JSON.stringify(mockBundle),
    });
  });
});
