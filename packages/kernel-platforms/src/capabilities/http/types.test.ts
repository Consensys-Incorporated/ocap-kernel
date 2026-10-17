import { describe, expect, it } from 'vitest';

import { httpConfigStruct } from './types.ts';
import { superstructValidationError } from '../../../test/utils.ts';

describe('httpConfigStruct', () => {
  it.each([
    { name: 'one host', config: { hosts: ['example.com'] } },
    {
      name: 'several hosts',
      config: { hosts: ['example.com', 'localhost'] },
    },
  ])('validates a config with $name', ({ config }) => {
    expect(httpConfigStruct.create(config)).toStrictEqual(config);
  });

  it.each([
    { name: 'no hosts', config: {} },
    // An empty host list would grant nothing, and an empty host every host.
    { name: 'an empty host list', config: { hosts: [] } },
    { name: 'an empty host', config: { hosts: [''] } },
    { name: 'a host given as labels', config: { hosts: [['com', 'example']] } },
    {
      name: 'a method list',
      config: { hosts: ['example.com'], methods: ['request'] },
    },
    {
      name: 'additional properties',
      config: { hosts: ['example.com'], allowedHosts: [] },
    },
  ])('rejects a config with $name', ({ config }) => {
    expect(() => httpConfigStruct.create(config)).toThrow(
      superstructValidationError,
    );
  });
});
