/// <reference types="ses"/>

import { vi } from 'vitest';

import { makePromiseKitMock } from '../promise-kit.ts';

globalThis.lockdown = vi.fn((): void => undefined);
globalThis.harden = vi.fn(
  <Value>(value: Value): Value => value,
) as typeof harden;

const assertFn = vi.fn((): void => undefined);
Object.assign(assertFn, {
  typeof: vi.fn(),
  error: vi.fn(),
  fail: vi.fn(),
  equal: vi.fn(),
  string: vi.fn(),
  note: vi.fn(),
  details: vi.fn(),
  Fail: vi.fn(),
  quote: vi.fn(),
  makeAssert: vi.fn(),
});
globalThis.assert = assertFn as unknown as typeof assert;

// @ts-expect-error: Mocks are lies
globalThis.HandledPromise = Promise;

// @ts-expect-error: Mocks are lies
globalThis.Compartment ??= vi.fn();

vi.mock('@endo/promise-kit', async () => {
  return makePromiseKitMock();
});

export {};
