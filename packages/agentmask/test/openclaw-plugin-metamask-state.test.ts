import { describe, expect, it, vi } from 'vitest';

import {
  createState,
  ensureVendor,
  isKref,
  parseCapabilityResponse,
  resolveCapability,
} from '../openclaw-plugin-metamask/state.ts';

describe('isKref', () => {
  it.each([
    ['ko0', true],
    ['ko5', true],
    ['ko123', true],
    ['PersonalMessageSigner', false],
    ['ko', false],
    ['ko5extra', false],
    ['KO5', false],
    ['', false],
  ])('isKref(%j) returns %j', (input, expected) => {
    expect(isKref(input)).toBe(expected);
  });
});

describe('parseCapabilityResponse', () => {
  it('extracts kref and name from well-formed CapData', () => {
    const capData = {
      body: '#"$0.Alleged: PersonalMessageSigner"',
      slots: ['ko5'],
    };
    const result = parseCapabilityResponse(capData);
    expect(result).toStrictEqual({
      kref: 'ko5',
      name: 'PersonalMessageSigner',
    });
  });

  it('falls back to kref as name when no Alleged pattern', () => {
    const capData = {
      body: '#"$0"',
      slots: ['ko7'],
    };
    const result = parseCapabilityResponse(capData);
    expect(result).toStrictEqual({ kref: 'ko7', name: 'ko7' });
  });

  it('throws on null input', () => {
    expect(() => parseCapabilityResponse(null)).toThrow(
      'Expected CapData object',
    );
  });

  it('throws on missing slots', () => {
    expect(() => parseCapabilityResponse({ body: '#"test"' })).toThrow(
      'Unexpected CapData shape',
    );
  });

  it('throws on empty slots', () => {
    expect(() =>
      parseCapabilityResponse({ body: '#"test"', slots: [] }),
    ).toThrow('Unexpected CapData shape');
  });

  it('throws on non-string slot', () => {
    expect(() =>
      parseCapabilityResponse({ body: '#"test"', slots: [42] }),
    ).toThrow('Expected string kref');
  });
});

describe('resolveCapability', () => {
  it('resolves a direct kref', () => {
    const state = createState();
    expect(resolveCapability('ko5', state)).toBe('ko5');
  });

  it('resolves a capability by name', () => {
    const state = createState();
    state.capabilities.set('PersonalMessageSigner', {
      kref: 'ko5',
      name: 'PersonalMessageSigner',
      description: 'sign messages',
      methods: undefined,
    });
    expect(resolveCapability('PersonalMessageSigner', state)).toBe('ko5');
  });

  it('throws for unknown name with hint', () => {
    const state = createState();
    state.capabilities.set('PersonalMessageSigner', {
      kref: 'ko5',
      name: 'PersonalMessageSigner',
      description: 'sign',
      methods: undefined,
    });
    expect(() => resolveCapability('Unknown', state)).toThrow(
      /Unknown capability.*PersonalMessageSigner/u,
    );
  });

  it('throws for unknown name with no capabilities hint', () => {
    const state = createState();
    expect(() => resolveCapability('Unknown', state)).toThrow(
      /No capabilities obtained/u,
    );
  });
});

describe('ensureVendor', () => {
  it('throws prompting for metamask_obtain_vendor when no URL set', async () => {
    const state = createState();
    const daemon = { redeemUrl: vi.fn(), queueMessage: vi.fn() };
    await expect(ensureVendor({ state, daemon })).rejects.toThrow(
      /metamask_obtain_vendor/u,
    );
    expect(daemon.redeemUrl).not.toHaveBeenCalled();
  });
});
