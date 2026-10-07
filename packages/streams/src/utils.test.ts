import { stringify } from '@metamask/kernel-utils';
import { makeErrorMatcherFactory } from '@ocap/repo-tools/test-utils';
import { describe, expect, it } from 'vitest';

import {
  makeDoneResult,
  makePendingResult,
  makeStreamDoneSignal,
  makeStreamErrorSignal,
  parseSignal,
  StreamSentinel,
} from './utils.ts';

const makeErrorMatcher = makeErrorMatcherFactory(expect);

describe('parseSignal', () => {
  it('returns undefined for a done signal', () => {
    expect(parseSignal(makeStreamDoneSignal())).toBeUndefined();
  });

  it('returns the error carried by an error signal', () => {
    expect(parseSignal(makeStreamErrorSignal(new Error('foo')))).toStrictEqual(
      makeErrorMatcher('foo'),
    );
  });

  it('throws if the value is not a valid stream signal', () => {
    const badSignal = { [StreamSentinel.Error]: true, error: 'foo' } as const;
    expect(() => parseSignal(badSignal)).toThrow(
      `Invalid stream signal: ${stringify(badSignal)}`,
    );
  });
});

describe('makeDoneResult', () => {
  it('should create a frozen done result', () => {
    const result = makeDoneResult();
    expect(result).toStrictEqual({ done: true, value: undefined });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('makePendingResult', () => {
  it('should create a frozen pending result', () => {
    const result = makePendingResult(42);
    expect(result).toStrictEqual({ done: false, value: 42 });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
