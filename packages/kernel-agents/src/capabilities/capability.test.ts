import { S } from '@metamask/kernel-utils';
import { describe, it, expect } from 'vitest';

import { extractCapabilities, extractCapabilitySchemas } from './capability.ts';
import { makeMethodCapability } from '../../test/make-method-capability.ts';

describe('capability extraction', () => {
  const makeRecord = () => ({
    ping: makeMethodCapability(
      'Server',
      'ping',
      async () => 'pong',
      S.method('Ping', [], S.string()),
    ),
  });

  it('extractCapabilities returns the functions keyed by name', async () => {
    const funcs = extractCapabilities(makeRecord());
    expect(Object.keys(funcs)).toStrictEqual(['ping']);
    expect(await funcs.ping?.(undefined as never)).toBe('pong');
  });

  it('extractCapabilitySchemas returns the schemas keyed by name', () => {
    const schemas = extractCapabilitySchemas(makeRecord());
    expect(schemas.ping).toStrictEqual({
      description: 'Ping',
      args: {},
      required: [],
      returns: { type: 'string' },
    });
  });
});
