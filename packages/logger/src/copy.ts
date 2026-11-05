export const CIRCULAR = '[Circular]';

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const copyValue = (
  value: unknown,
  ancestors: Set<object>,
  copies: WeakMap<object, unknown>,
): unknown => {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  if (copies.has(value)) {
    return copies.get(value);
  }

  ancestors.add(value);
  const keys = isArray
    ? Array.from({ length: value.length }, (_, index) => String(index)).filter(
        (key) => Object.hasOwn(value, key),
      )
    : Object.keys(value);
  let changed = !Object.isFrozen(value);
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) {
      const childCopy = copyValue(descriptor.value, ancestors, copies);
      changed ||= childCopy !== descriptor.value;
      entries.push([key, childCopy]);
    } else {
      changed = true;
    }
  }
  ancestors.delete(value);

  let copy: unknown = value;
  if (changed) {
    if (isArray) {
      const array: unknown[] = [];
      array.length = value.length;
      for (const [key, item] of entries) {
        array[Number(key)] = item;
      }
      copy = Object.freeze(array);
    } else {
      // `fromEntries` defines an own `__proto__` key as data.
      copy = Object.freeze(Object.fromEntries(entries));
    }
  }
  copies.set(value, copy);
  return copy;
};

/**
 * Copy plain objects and arrays into frozen copies, each object once. Copies
 * keep string-keyed data properties only (array indices for arrays). A frozen
 * plain object or array whose contents need no copying is kept as is.
 * Functions and class instances are kept by reference. A reference to an
 * object being copied becomes {@link CIRCULAR}.
 *
 * @param value - The value to copy.
 * @returns The copy.
 */
export const copyData = (value: unknown): unknown =>
  copyValue(value, new Set(), new WeakMap());
