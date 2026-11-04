import { describe, it, expect, vi } from 'vitest';

import { CIRCULAR, copyData } from './copy.ts';

class Thing {
  value = 1;
}

describe('copyData', () => {
  it.each([
    ['a string', 'text'],
    ['a number', 1],
    ['undefined', undefined],
    ['null', null],
    ['a function', () => undefined],
    ['a class instance', new Thing()],
    ['an error', new Error('oops')],
    ['a promise', Promise.resolve()],
    ['a deeply frozen object', Object.freeze({ a: Object.freeze([1]) })],
  ])('keeps %s by reference', (_description, value) => {
    expect(copyData(value)).toBe(value);
  });

  it('copies nested objects and arrays into frozen copies', () => {
    const value = { list: [{ a: 1 }], nested: { b: 'x' } };
    const copy = copyData(value) as typeof value;

    expect(copy).toStrictEqual(value);
    expect(copy).not.toBe(value);
    expect(copy.list).not.toBe(value.list);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.list)).toBe(true);
    expect(Object.isFrozen(copy.list[0])).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('copies a frozen object whose contents are mutable', () => {
    const inner = { a: 1 };
    const value = Object.freeze({ inner });
    const copy = copyData(value) as typeof value;

    expect(copy).not.toBe(value);
    expect(copy.inner).not.toBe(inner);
    expect(Object.isFrozen(inner)).toBe(false);
  });

  it('copies an object with a null prototype', () => {
    const value = Object.assign(Object.create(null), { a: 1 });
    expect(copyData(value)).toStrictEqual({ a: 1 });
  });

  it('keeps class instances inside a copy by reference', () => {
    const thing = new Thing();
    const copy = copyData({ thing }) as { thing: Thing };
    expect(copy.thing).toBe(thing);
    expect(Object.isFrozen(thing)).toBe(false);
  });

  it('marks cycles', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    value.list = [value];
    expect(copyData(value)).toStrictEqual({
      a: 1,
      self: CIRCULAR,
      list: [CIRCULAR],
    });
  });

  it('copies an object referenced twice once', () => {
    const shared = { a: 1 };
    const copy = copyData([shared, shared]) as unknown[];
    expect(copy).toStrictEqual([{ a: 1 }, { a: 1 }]);
    expect(copy[0]).toBe(copy[1]);
  });

  it('copies array indices only, keeping the length', () => {
    const value: unknown[] = Object.assign([1], { extra: 'x' });
    value[2] = 3;
    value.length = 4;
    const copy = copyData(value) as unknown[];
    expect(copy).toHaveLength(4);
    expect(Object.keys(copy)).toStrictEqual(['0', '2']);
  });

  it('copies data properties only and does not invoke accessors', () => {
    const getter = vi.fn(() => 'secret');
    const value = Object.defineProperty({ a: 1 }, 'b', {
      get: getter,
      enumerable: true,
    });
    const frozen = Object.freeze(
      Object.defineProperty({ a: 1 }, 'b', { get: getter, enumerable: true }),
    );

    expect(copyData(value)).toStrictEqual({ a: 1 });
    expect(copyData(frozen)).toStrictEqual({ a: 1 });
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies an own `__proto__` key as data', () => {
    const value = JSON.parse('{"__proto__":{"a":1}}') as object;
    const copy = copyData(value) as object;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toStrictEqual(['__proto__']);
  });
});
