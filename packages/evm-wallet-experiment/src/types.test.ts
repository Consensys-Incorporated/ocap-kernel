import { describe, it, expect } from 'vitest';

import { makeChainConfig } from './types.ts';

describe('makeChainConfig', () => {
  it('creates a valid chain config', () => {
    const config = makeChainConfig({
      chainId: 1,
      rpcUrl: 'https://eth.example.com',
    });

    expect(config).toStrictEqual({
      chainId: 1,
      rpcUrl: 'https://eth.example.com',
    });
  });

  it('accepts optional name', () => {
    const config = makeChainConfig({
      chainId: 137,
      rpcUrl: 'https://polygon.example.com',
      name: 'Polygon',
    });

    expect(config).toStrictEqual({
      chainId: 137,
      rpcUrl: 'https://polygon.example.com',
      name: 'Polygon',
    });
  });

  it('throws for invalid chainId type', () => {
    expect(() =>
      makeChainConfig({
        // oxlint-disable-next-line typescript/no-explicit-any
        chainId: 'one' as any,
        rpcUrl: 'https://eth.example.com',
      }),
    ).toThrow('Expected a number');
  });

  it('throws for invalid rpcUrl type', () => {
    expect(() =>
      makeChainConfig({
        chainId: 1,
        // oxlint-disable-next-line typescript/no-explicit-any
        rpcUrl: 123 as any,
      }),
    ).toThrow('Expected a string');
  });
});
