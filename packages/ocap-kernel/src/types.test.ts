import type { Message, VatSyscallObject } from '@agoric/swingset-liveslots';
import { describe, it, expect } from 'vitest';

import {
  isVatConfig,
  insistKernelMessage,
  insistEndpointMessage,
  coerceEndpointMessage,
  coerceVatSyscallObject,
  queueTypeFromActionType,
  isGCActionType,
  insistGCActionType,
  isGCAction,
  insistGCAction,
  makeGCAction,
  isVatMessageId,
  isSubclusterId,
  insistSubclusterId,
  isKRef,
  insistKRef,
  isVRef,
  insistVRef,
  isRRef,
  insistRRef,
  isERef,
  insistERef,
  isVatId,
  isRemoteId,
  insistRemoteId,
  isEndpointId,
  insistVatId,
  insistEndpointId,
} from './types.ts';
import type { EndpointId, KRef } from './types.ts';

describe('isVatConfig', () => {
  it.each([
    {
      name: 'simple sourceSpec',
      config: { sourceSpec: 'source.js' },
      expected: true,
    },
    {
      name: 'sourceSpec with options',
      config: {
        sourceSpec: 'source.js',
        creationOptions: { foo: 'bar' },
        parameters: { baz: 123 },
      },
      expected: true,
    },
    {
      name: 'simple bundleSpec',
      config: { bundleSpec: 'bundle.js' },
      expected: true,
    },
    {
      name: 'bundleSpec with options',
      config: {
        bundleSpec: 'bundle.js',
        creationOptions: { foo: 'bar' },
        parameters: { baz: 123 },
      },
      expected: true,
    },
    {
      name: 'simple bundleName',
      config: { bundleName: 'myBundle' },
      expected: true,
    },
    {
      name: 'bundleName with options',
      config: {
        bundleName: 'myBundle',
        creationOptions: { foo: 'bar' },
        parameters: { baz: 123 },
      },
      expected: true,
    },
  ])('validates $name', ({ config, expected }) => {
    expect(isVatConfig(config)).toBe(expected);
  });

  it.each([
    {
      name: 'sourceSpec and bundleSpec',
      config: { sourceSpec: 'source.js', bundleSpec: 'bundle.js' },
    },
    {
      name: 'sourceSpec and bundleName',
      config: { sourceSpec: 'source.js', bundleName: 'myBundle' },
    },
    {
      name: 'bundleSpec and bundleName',
      config: { bundleSpec: 'bundle.js', bundleName: 'myBundle' },
    },
    {
      name: 'all three specs',
      config: {
        sourceSpec: 'source.js',
        bundleSpec: 'bundle.js',
        bundleName: 'myBundle',
      },
    },
  ])('rejects configs with $name', ({ config }) => {
    expect(isVatConfig(config)).toBe(false);
  });

  it.each([
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'string', value: 'string' },
    { name: 'number', value: 123 },
    { name: 'array', value: [] },
    { name: 'empty object', value: {} },
  ])('rejects $name', ({ value }) => {
    expect(isVatConfig(value)).toBe(false);
  });

  it.each([
    {
      name: 'with valid platformConfig',
      config: {
        bundleSpec: 'bundle.js',
        platformConfig: {
          fs: { rootDir: '/tmp' },
        },
      },
      expected: true,
    },
    {
      name: 'with valid platformConfig and other options',
      config: {
        bundleSpec: 'bundle.js',
        creationOptions: { foo: 'bar' },
        parameters: { baz: 123 },
        platformConfig: {
          fs: { rootDir: '/tmp', methods: ['readFile'] },
        },
      },
      expected: true,
    },
    {
      name: 'with valid network config',
      config: {
        bundleSpec: 'bundle.js',
        globals: ['fetch'],
        network: { allowedHosts: ['api.github.com'] },
      },
      expected: true,
    },
  ])('validates $name', ({ config, expected }) => {
    expect(isVatConfig(config)).toBe(expected);
  });

  it.each([
    {
      name: 'invalid platformConfig structure',
      config: {
        bundleSpec: 'bundle.js',
        platformConfig: {
          fs: { rootDir: 123 },
        },
      },
    },
    {
      name: 'network.allowedHosts not an array',
      config: {
        bundleSpec: 'bundle.js',
        network: { allowedHosts: 'not-an-array' },
      },
    },
    {
      name: 'network.allowedHosts contains non-strings',
      config: {
        bundleSpec: 'bundle.js',
        network: { allowedHosts: ['ok.test', 123] },
      },
    },
  ])('rejects configs with $name', ({ config }) => {
    expect(isVatConfig(config)).toBe(false);
  });

  it.each([
    {
      name: 'with valid globals array',
      config: {
        bundleSpec: 'bundle.js',
        globals: ['Date'],
      },
      expected: true,
    },
    {
      name: 'with empty globals array',
      config: {
        bundleSpec: 'bundle.js',
        globals: [],
      },
      expected: true,
    },
    {
      name: 'with multiple globals',
      config: {
        bundleSpec: 'bundle.js',
        globals: ['Date', 'Math'],
      },
      expected: true,
    },
  ])('validates $name', ({ config, expected }) => {
    expect(isVatConfig(config)).toBe(expected);
  });

  it.each([
    {
      name: 'non-array globals',
      config: {
        bundleSpec: 'bundle.js',
        globals: 'Date',
      },
    },
    {
      name: 'globals array with non-string element',
      config: {
        bundleSpec: 'bundle.js',
        globals: ['Date', 123],
      },
    },
  ])('rejects configs with $name', ({ config }) => {
    expect(isVatConfig(config)).toBe(false);
  });
});

describe('insistKernelMessage', () => {
  it('does not throw for valid message objects', () => {
    const validMessage = {
      methargs: { body: 'body content', slots: [] },
      result: 'kp1',
    };

    expect(() => insistKernelMessage(validMessage)).not.toThrow();
  });

  it('does not throw for message with KRef slots', () => {
    const validMessage = {
      methargs: { body: 'body content', slots: ['ko1', 'kp2'] },
      result: 'ko3',
    };

    expect(() => insistKernelMessage(validMessage)).not.toThrow();
  });

  it.each([
    { name: 'empty object', value: {} },
    { name: 'incomplete methargs', value: { methargs: {} } },
    { name: 'missing slots', value: { methargs: { body: 'body' } } },
    { name: 'missing methargs', value: { result: 'kp1' } },
    {
      name: 'non-KRef slot',
      value: { methargs: { body: 'body', slots: ['invalid'] } },
    },
    {
      name: 'non-KRef result',
      value: { methargs: { body: 'body', slots: [] }, result: 'invalid' },
    },
  ])('throws for $name', ({ value }) => {
    expect(() => insistKernelMessage(value)).toThrow(
      'not a valid kernel message',
    );
  });
});

describe('insistEndpointMessage', () => {
  it('does not throw for valid message with ERef slots', () => {
    const validMessage = {
      methargs: { body: 'body content', slots: ['o+1', 'p-2'] },
      result: 'o+0',
    };

    expect(() => insistEndpointMessage(validMessage)).not.toThrow();
  });

  it('does not throw for message with RRef slots', () => {
    const validMessage = {
      methargs: { body: 'body content', slots: ['ro+1', 'rp-2'] },
    };

    expect(() => insistEndpointMessage(validMessage)).not.toThrow();
  });

  it.each([
    {
      name: 'non-ERef slot',
      value: { methargs: { body: 'body', slots: ['invalid'] } },
    },
    {
      name: 'KRef slot',
      value: { methargs: { body: 'body', slots: ['ko1'] } },
    },
    {
      name: 'non-ERef result',
      value: { methargs: { body: 'body', slots: [] }, result: 'ko1' },
    },
  ])('throws for $name', ({ value }) => {
    expect(() => insistEndpointMessage(value)).toThrow(
      'not a valid endpoint message',
    );
  });
});

describe('queueTypeFromActionType', () => {
  it('maps GC action types to queue event types', () => {
    // Note: From singular to plural
    expect(queueTypeFromActionType.get('dropExport')).toBe('dropExports');
    expect(queueTypeFromActionType.get('retireExport')).toBe('retireExports');
    expect(queueTypeFromActionType.get('retireImport')).toBe('retireImports');
    expect(queueTypeFromActionType.size).toBe(3);
  });
});

describe('isGCActionType', () => {
  it.each(['dropExport', 'retireExport', 'retireImport'])(
    'returns true for valid GC action type %s',
    (value) => {
      expect(isGCActionType(value)).toBe(true);
    },
  );

  it.each([
    { name: 'invalid string', value: 'invalidAction' },
    { name: 'empty string', value: '' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
  ])('returns false for $name', ({ value }) => {
    expect(isGCActionType(value)).toBe(false);
  });
});

describe('insistGCActionType', () => {
  it.each(['dropExport', 'retireExport', 'retireImport'])(
    'does not throw for valid GC action type %s',
    (value) => {
      expect(() => insistGCActionType(value)).not.toThrow();
    },
  );

  it.each([
    { name: 'invalid string', value: 'invalidAction' },
    { name: 'empty string', value: '' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
  ])('throws for $name', ({ value }) => {
    expect(() => insistGCActionType(value)).toThrow('not a valid GCActionType');
  });
});

describe('isGCAction', () => {
  it.each([
    'v1 dropExport ko123',
    'v2 retireExport ko456',
    'v3 retireImport ko789',
  ])('returns true for valid GC action %s', (value) => {
    expect(isGCAction(value)).toBe(true);
  });

  it.each([
    { name: 'invalid vatId', value: 'invalid dropExport ko123' },
    { name: 'invalid action type', value: 'v1 invalidAction ko123' },
    { name: 'invalid kref', value: 'v1 dropExport invalid' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'missing spaces', value: 'v1dropExportko123' },
  ])('returns false for $name', ({ value }) => {
    expect(isGCAction(value)).toBe(false);
  });
});

describe('coerceEndpointMessage', () => {
  it('removes undefined result field', () => {
    const messageWithUndefined = {
      methargs: { body: 'test', slots: [] },
      result: undefined,
    };

    const coerced = coerceEndpointMessage(
      messageWithUndefined as unknown as Message,
    );
    expect(coerced).not.toHaveProperty('result');
    expect(coerced.methargs).toStrictEqual({ body: 'test', slots: [] });
  });

  it('preserves defined result field', () => {
    const messageWithResult = {
      methargs: { body: 'test', slots: [] },
      result: 'p+1',
    };

    const coerced = coerceEndpointMessage(messageWithResult);
    expect(coerced.result).toBe('p+1');
    expect(coerced.methargs).toStrictEqual({ body: 'test', slots: [] });
  });
});

describe('coerceVatSyscallObject', () => {
  it('coerces send syscalls to use coerced message', () => {
    const sendSyscall = [
      'send',
      'target',
      { methargs: { body: 'test', slots: [] }, result: undefined },
    ] as unknown as VatSyscallObject;

    const coerced = coerceVatSyscallObject(sendSyscall);
    expect(coerced[0]).toBe('send');
    expect(coerced[1]).toBe('target');
    expect(coerced[2]).not.toHaveProperty('result');
  });

  it('passes through non-send syscalls unchanged', () => {
    const resolveSyscall = [
      'resolve',
      [['kp1', false, { body: 'data', slots: [] }]],
    ] as unknown as VatSyscallObject;

    const coerced = coerceVatSyscallObject(resolveSyscall);
    expect(coerced).toBe(resolveSyscall);
  });
});

describe('isVatId', () => {
  it.each(['v0', 'v1', 'v42', 'v123456789'])(
    'returns true for valid vat ID %s',
    (id) => {
      expect(isVatId(id)).toBe(true);
    },
  );

  it.each([
    { name: 'wrong prefix r', value: 'r1' },
    { name: 'wrong prefix x', value: 'x1' },
    { name: 'missing number part', value: 'v' },
    { name: 'non-numeric suffix', value: 'va' },
    { name: 'mixed suffix', value: 'v1a' },
    { name: 'float suffix', value: 'v1.5' },
    { name: 'negative', value: 'v-1' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
  ])('returns false for $name', ({ value }) => {
    expect(isVatId(value)).toBe(false);
  });
});

describe('isRemoteId', () => {
  it.each(['r0', 'r1', 'r42', 'r123456789'])(
    'returns true for valid remote ID %s',
    (id) => {
      expect(isRemoteId(id)).toBe(true);
    },
  );

  it.each([
    { name: 'wrong prefix v', value: 'v1' },
    { name: 'wrong prefix x', value: 'x1' },
    { name: 'missing number part', value: 'r' },
    { name: 'non-numeric suffix', value: 'ra' },
    { name: 'mixed suffix', value: 'r1a' },
  ])('returns false for $name', ({ value }) => {
    expect(isRemoteId(value)).toBe(false);
  });
});

describe('isEndpointId', () => {
  it.each(['v0', 'v1', 'r0', 'r1', 'v42', 'r123456789'])(
    'returns true for valid endpoint ID %s',
    (id) => {
      expect(isEndpointId(id)).toBe(true);
    },
  );

  it.each([
    { name: 'wrong prefix x', value: 'x1' },
    { name: 'missing number part', value: 'v' },
    { name: 'non-numeric suffix', value: 'va' },
  ])('returns false for $name', ({ value }) => {
    expect(isEndpointId(value)).toBe(false);
  });
});

describe('isSubclusterId', () => {
  it.each(['s0', 's1', 's42', 's123456789'])(
    'returns true for valid subcluster ID %s',
    (id) => {
      expect(isSubclusterId(id)).toBe(true);
    },
  );

  it.each([
    { name: 'wrong prefix v', value: 'v1' },
    { name: 'wrong prefix x', value: 'x1' },
    { name: 'missing number part', value: 's' },
    { name: 'non-numeric suffix', value: 'sa' },
  ])('returns false for $name', ({ value }) => {
    expect(isSubclusterId(value)).toBe(false);
  });
});

describe('insistVatId', () => {
  it.each(['v0', 'v1', 'v42'])('does not throw for valid vat ID %s', (id) => {
    expect(() => insistVatId(id)).not.toThrow();
  });

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'wrong prefix', value: 'r1' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistVatId(value)).toThrow('not a valid VatId');
  });
});

describe('insistEndpointId', () => {
  it.each(['v0', 'v1', 'r0', 'r1'])(
    'does not throw for valid endpoint ID %s',
    (id) => {
      expect(() => insistEndpointId(id)).not.toThrow();
    },
  );

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'wrong prefix', value: 'x1' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistEndpointId(value)).toThrow('not a valid EndpointId');
  });
});

describe('isVatMessageId', () => {
  it.each(['m0', 'm1', 'm42', 'm123456789'])(
    'returns true for valid message ID %s',
    (id) => {
      expect(isVatMessageId(id)).toBe(true);
    },
  );

  it.each([
    { name: 'wrong prefix x', value: 'x1' },
    { name: 'wrong prefix n', value: 'n42' },
    { name: 'missing number part', value: 'm' },
    { name: 'non-numeric suffix (a)', value: 'ma' },
    { name: 'non-numeric suffix (1a)', value: 'm1a' },
    { name: 'non-numeric suffix (42x)', value: 'm42x' },
    { name: 'reversed format', value: '1m' },
    { name: 'double prefix', value: 'mm1' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'object', value: {} },
    { name: 'array', value: [] },
  ])('returns false for $name', ({ value }) => {
    expect(isVatMessageId(value)).toBe(false);
  });
});

describe('isKRef', () => {
  it.each(['ko0', 'ko1', 'kp42', 'ko123456789'])(
    'returns true for valid KRef %s',
    (value) => {
      expect(isKRef(value)).toBe(true);
    },
  );

  it.each([
    { name: 'missing k prefix', value: 'o1' },
    { name: 'invalid type char', value: 'kx1' },
    { name: 'no digits', value: 'ko' },
    { name: 'non-digit suffix', value: 'ko1abc' },
    { name: 'float suffix', value: 'ko1.5' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
  ])('returns false for $name', ({ value }) => {
    expect(isKRef(value)).toBe(false);
  });
});

describe('insistKRef', () => {
  it.each(['ko0', 'ko1', 'kp42'])(
    'does not throw for valid KRef %s',
    (value) => {
      expect(() => insistKRef(value)).not.toThrow();
    },
  );

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'missing digits', value: 'ko' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistKRef(value)).toThrow('not a valid KRef');
  });
});

describe('isVRef', () => {
  it.each([
    'o+0',
    'o-1',
    'p+42',
    'p-0',
    'o+123456789',
    // Vat-allocated durable / virtual objects (liveslots `defineDurableKind`
    // and friends). See parseVatSlot in @agoric/swingset-liveslots.
    'o+d10/1',
    'o+v3/4',
    'o+d10/1:0',
    'o+v3/4:7',
  ])('returns true for valid VRef %s', (value) => {
    expect(isVRef(value)).toBe(true);
  });

  it.each([
    { name: 'missing sign', value: 'o1' },
    { name: 'wrong prefix', value: 'x+1' },
    { name: 'no digits', value: 'o+' },
    { name: 'non-digit suffix', value: 'o+1abc' },
    { name: 'kernel ref', value: 'ko1' },
    { name: 'remote ref', value: 'ro+1' },
    // Durability marker only valid on `o+`. `o-` is kernel-allocated;
    // promises and devices never carry a durability/subid suffix.
    { name: 'durable on import', value: 'o-d10/1' },
    { name: 'durable on promise', value: 'p+d10/1' },
    // Subid grammar requires a durability marker.
    { name: 'subid without marker', value: 'o+10/1' },
    // Facet requires a subid.
    { name: 'facet without subid', value: 'o+d10:0' },
    // Device refs are not supported by this kernel.
    { name: 'device ref', value: 'd+0' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
  ])('returns false for $name', ({ value }) => {
    expect(isVRef(value)).toBe(false);
  });
});

describe('insistVRef', () => {
  it.each(['o+0', 'p-1', 'o+42', 'o+d10/1', 'o+v3/4:7'])(
    'does not throw for valid VRef %s',
    (value) => {
      expect(() => insistVRef(value)).not.toThrow();
    },
  );

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'kernel ref', value: 'ko1' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistVRef(value)).toThrow('not a valid VRef');
  });
});

describe('isRRef', () => {
  it.each(['ro+0', 'ro-1', 'rp+42', 'rp-0', 'ro+123456789'])(
    'returns true for valid RRef %s',
    (value) => {
      expect(isRRef(value)).toBe(true);
    },
  );

  it.each([
    { name: 'missing r prefix', value: 'o+1' },
    { name: 'missing sign', value: 'ro1' },
    { name: 'wrong inner char', value: 'rx+1' },
    { name: 'no digits', value: 'ro+' },
    { name: 'non-digit suffix', value: 'ro+1abc' },
    { name: 'kernel ref', value: 'ko1' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
  ])('returns false for $name', ({ value }) => {
    expect(isRRef(value)).toBe(false);
  });
});

describe('insistRRef', () => {
  it.each(['ro+0', 'rp-1', 'ro+42'])(
    'does not throw for valid RRef %s',
    (value) => {
      expect(() => insistRRef(value)).not.toThrow();
    },
  );

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'vat ref', value: 'o+1' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistRRef(value)).toThrow('not a valid RRef');
  });
});

describe('isERef', () => {
  it.each(['o+0', 'p-1', 'ro+1', 'rp-2', 'o+d10/1', 'o+v3/4:7'])(
    'returns true for valid ERef %s',
    (value) => {
      expect(isERef(value)).toBe(true);
    },
  );

  it.each([
    { name: 'kernel ref', value: 'ko1' },
    { name: 'plain string', value: 'invalid' },
    { name: 'number', value: 123 },
    { name: 'null', value: null },
  ])('returns false for $name', ({ value }) => {
    expect(isERef(value)).toBe(false);
  });
});

describe('insistERef', () => {
  it.each(['o+0', 'p-1', 'ro+1', 'rp-2', 'o+d10/1', 'o+v3/4:7'])(
    'does not throw for valid ERef %s',
    (value) => {
      expect(() => insistERef(value)).not.toThrow();
    },
  );

  it.each([
    { name: 'kernel ref', value: 'ko1' },
    { name: 'invalid format', value: 'invalid' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistERef(value)).toThrow('not a valid ERef');
  });
});

describe('insistRemoteId', () => {
  it.each(['r0', 'r1', 'r42'])(
    'does not throw for valid remote ID %s',
    (id) => {
      expect(() => insistRemoteId(id)).not.toThrow();
    },
  );

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'wrong prefix', value: 'v1' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistRemoteId(value)).toThrow('not a valid RemoteId');
  });
});

describe('insistSubclusterId', () => {
  it.each(['s0', 's1', 's42'])(
    'does not throw for valid subcluster ID %s',
    (id) => {
      expect(() => insistSubclusterId(id)).not.toThrow();
    },
  );

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'wrong prefix', value: 'v1' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistSubclusterId(value)).toThrow('not a valid SubclusterId');
  });
});

describe('insistGCAction', () => {
  it.each([
    'v1 dropExport ko123',
    'v2 retireExport ko456',
    'r1 retireImport ko789',
  ])('does not throw for valid GC action %s', (value) => {
    expect(() => insistGCAction(value)).not.toThrow();
  });

  it.each([
    { name: 'invalid format', value: 'invalid' },
    { name: 'invalid vatId', value: 'invalid dropExport ko123' },
    { name: 'invalid action type', value: 'v1 invalidAction ko123' },
    { name: 'number', value: 123 },
  ])('throws for $name', ({ value }) => {
    expect(() => insistGCAction(value)).toThrow('not a valid GCAction');
  });
});

describe('makeGCAction', () => {
  it('creates a valid GCAction from valid inputs', () => {
    const action = makeGCAction(
      'v1' as EndpointId,
      'dropExport',
      'ko1' as KRef,
    );
    expect(action).toBe('v1 dropExport ko1');
    expect(isGCAction(action)).toBe(true);
  });

  it('throws for non-object kref', () => {
    expect(() =>
      makeGCAction('v1' as EndpointId, 'dropExport', 'kp1' as KRef),
    ).toThrow('GC actions only apply to objects');
  });
});
