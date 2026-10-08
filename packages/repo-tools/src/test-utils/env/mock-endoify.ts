// eslint-disable-next-line spaced-comment
/// <reference types="ses"/>

import { vi } from 'vitest';

import { makePromiseKitMock } from '../promise-kit.ts';

globalThis.lockdown = vi.fn((): void => undefined);
globalThis.harden = vi.fn(<Value>(value: Value): Readonly<Value> => value);

// Nothing `assert` guards throws under this shim. `@endo/exo` rejects a guard
// violation through `assert.Fail`, so such a rejection carries `undefined`, and
// `rejects.toThrow` counts an `undefined` rejection as matching anything —
// assert a guard refusal by an observable consequence instead. Making `Fail`
// throw does not fix that on its own: `@endo/patterns` calls `assert.fail`
// while initializing, so a throwing stub stops test files from loading.
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
