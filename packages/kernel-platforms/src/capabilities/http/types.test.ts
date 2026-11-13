import { describe, expect, it } from 'vitest';

import { httpConfigStruct } from './types.ts';
import { superstructValidationError } from '../../../test/utils.ts';

describe('httpConfigStruct', () => {
  it.each([
    { name: 'one rule', config: { allow: [{ host: 'example.com' }] } },
    {
      name: 'several rules',
      config: { allow: [{ host: 'example.com' }, { host: 'localhost' }] },
    },
    {
      name: 'every constraint',
      config: {
        allow: [
          {
            host: 'api.example.com',
            exactHost: true,
            path: 'v1/users',
            exactPath: false,
            protocol: 'https',
            ports: [8443],
            methods: ['GET', 'POST'],
          },
        ],
      },
    },
    {
      name: 'default ports only',
      config: { allow: [{ host: 'example.com', ports: [] }] },
    },
  ])('validates a config with $name', ({ config }) => {
    expect(httpConfigStruct.create(config)).toStrictEqual(config);
  });

  it.each([
    { name: 'no rules', config: {} },
    // An empty rule list would grant nothing, and an empty host every host.
    { name: 'an empty rule list', config: { allow: [] } },
    { name: 'an empty host', config: { allow: [{ host: '' }] } },
    {
      name: 'a host given as labels',
      config: { allow: [{ host: ['com', 'example'] }] },
    },
    {
      name: 'an unknown protocol',
      config: { allow: [{ host: 'example.com', protocol: 'ftp' }] },
    },
    {
      name: 'a port out of range',
      config: { allow: [{ host: 'example.com', ports: [0] }] },
    },
    {
      name: 'a fractional port',
      config: { allow: [{ host: 'example.com', ports: [80.5] }] },
    },
    {
      name: 'a lowercase method',
      config: { allow: [{ host: 'example.com', methods: ['get'] }] },
    },
    {
      name: 'an empty method list',
      config: { allow: [{ host: 'example.com', methods: [] }] },
    },
    {
      name: 'the former host list',
      config: { hosts: ['example.com'] },
    },
    {
      name: 'additional rule properties',
      config: { allow: [{ host: 'example.com', hosts: [] }] },
    },
  ])('rejects a config with $name', ({ config }) => {
    expect(() => httpConfigStruct.create(config)).toThrow(
      superstructValidationError,
    );
  });
});
