import type { CapData, PassStyle } from '@endo/marshal';
import { passStyleOf } from '@endo/pass-style';
import { describe, it, expect, vi } from 'vitest';

import { extractSingleRef } from './extract-ref.ts';
import { asKRef } from '../../../test/branded.ts';
import { kunser, krefOf } from '../../liveslots/kernel-marshal.ts';
import type { KRef } from '../../types.ts';

vi.mock('@endo/pass-style', async () => {
  const actual = await vi.importActual('@endo/pass-style');
  return {
    ...actual,
    passStyleOf: vi.fn(),
  };
});

vi.mock('../../liveslots/kernel-marshal.ts', () => ({
  kunser: vi.fn(),
  krefOf: vi.fn(),
}));

describe('extract-ref', () => {
  describe('extractSingleRef', () => {
    const mockedPassStyleOf = vi.mocked(passStyleOf);
    const mockedKunser = vi.mocked(kunser);
    const mockedKrefOf = vi.mocked(krefOf);

    it.each([
      { type: 'remotable', expected: asKRef('ko123') },
      { type: 'promise', expected: asKRef('kp456') },
    ])('returns the kref when style is $type', ({ type, expected }) => {
      const capData: CapData<KRef> = { body: 'test', slots: [] };
      const mockValue = { type };
      mockedKunser.mockReturnValue(mockValue);
      mockedPassStyleOf.mockReturnValue(type as PassStyle);
      mockedKrefOf.mockReturnValue(expected);
      const result = extractSingleRef(capData);
      expect(mockedKunser).toHaveBeenCalledWith(capData);
      expect(mockedPassStyleOf).toHaveBeenCalledWith(mockValue);
      expect(mockedKrefOf).toHaveBeenCalledWith(mockValue);
      expect(result).toBe(expected);
    });

    it('returns null when style is neither remotable nor promise', () => {
      const capData: CapData<KRef> = { body: 'test', slots: [] };
      const mockValue = { type: 'other' };
      mockedKunser.mockReturnValue(mockValue);
      mockedPassStyleOf.mockReturnValue('other' as PassStyle);
      const result = extractSingleRef(capData);
      expect(mockedKunser).toHaveBeenCalledWith(capData);
      expect(mockedPassStyleOf).toHaveBeenCalledWith(mockValue);
      expect(mockedKrefOf).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });
});
