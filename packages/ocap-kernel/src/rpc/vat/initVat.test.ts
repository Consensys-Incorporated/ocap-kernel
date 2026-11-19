import { describe, it, expect, vi } from 'vitest';

import { initVatHandler, initVatSpec } from './initVat.ts';
import type { InitVat } from './initVat.ts';

describe('initVatSpec', () => {
  it('accepts a checkpoint, an error and a bundle hash', () => {
    expect(
      initVatSpec.result.is([[[['k', 'v']], ['d']], null, 'sha256:00']),
    ).toBe(true);
    expect(
      initVatSpec.result.is([[[['k', 'v']], ['d']], 'boom', 'sha256:00']),
    ).toBe(true);
  });

  it('refuses a result without the bundle hash', () => {
    expect(initVatSpec.result.is([[[['k', 'v']], ['d']], null])).toBe(false);
  });
});

describe('initVatHandler', () => {
  it('should initialize a vat', async () => {
    const initVat = vi.fn(() => ({ checkpoint: 'fake' })) as unknown as InitVat;
    const result = initVatHandler.implementation(
      { initVat },
      {
        vatConfig: { sourceSpec: 'test' },
        state: [],
      },
    );
    expect(await result).toStrictEqual({
      checkpoint: 'fake',
    });
  });

  it('should propagate errors from hooks', async () => {
    const initVat = vi.fn(() => {
      throw new Error('fake');
    });
    await expect(
      initVatHandler.implementation(
        { initVat },
        {
          vatConfig: { sourceSpec: 'test' },
          state: [],
        },
      ),
    ).rejects.toThrow('fake');
  });
});
