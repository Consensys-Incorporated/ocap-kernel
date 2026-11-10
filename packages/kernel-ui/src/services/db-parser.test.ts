import type { KRef } from '@metamask/ocap-kernel';
import { describe, it, expect } from 'vitest';

import type { ObjectRegistry } from '../types.ts';
import { parseObjectRegistry } from './db-parser.ts';

describe('parseObjectRegistry', () => {
  it('should parse kernel DB entries into structured vat data', () => {
    const entries = [
      { key: 'queue.run.head', value: '6' },
      { key: 'queue.run.tail', value: '6' },
      { key: 'gcActions', value: '[]' },
      { key: 'reapQueue', value: '[]' },
      { key: 'vats.terminated', value: '[]' },
      { key: 'nextObjectId', value: '4' },
      { key: 'nextPromiseId', value: '4' },
      { key: 'nextVatId', value: '4' },
      { key: 'nextRemoteId', value: '1' },
      { key: 'e.nextPromiseId.v1', value: '2' },
      { key: 'e.nextObjectId.v1', value: '3' },
      { key: 'ko1.owner', value: 'v1' },
      { key: 'ko1.refCount', value: '1,1' },
      { key: 'v1.c.ko1', value: 'R o+0' },
      { key: 'v1.c.o+0', value: 'ko1' },
      {
        key: 'vatConfig.v1',
        value:
          '{"bundleSpec":"http://localhost:3000/sample-vat.bundle","parameters":{"name":"Alice"}}',
      },
      { key: 'e.nextPromiseId.v2', value: '2' },
      { key: 'e.nextObjectId.v2', value: '1' },
      { key: 'ko2.owner', value: 'v2' },
      { key: 'ko2.refCount', value: '1,1' },
      { key: 'ko2.revoked', value: 'true' },
      { key: 'v2.c.ko2', value: 'R o+0' },
      { key: 'v2.c.o+0', value: 'ko2' },
      {
        key: 'vatConfig.v2',
        value:
          '{"bundleSpec":"http://localhost:3000/sample-vat.bundle","parameters":{"name":"Bob"}}',
      },
      { key: 'e.nextPromiseId.v3', value: '2' },
      { key: 'e.nextObjectId.v3', value: '1' },
      { key: 'ko3.owner', value: 'v3' },
      { key: 'ko3.refCount', value: '1,1' },
      { key: 'v3.c.ko3', value: 'R o+0' },
      { key: 'v3.c.o+0', value: 'ko3' },
      {
        key: 'vatConfig.v3',
        value:
          '{"bundleSpec":"http://localhost:3000/sample-vat.bundle","parameters":{"name":"Carol"}}',
      },
      { key: 'kp1.state', value: 'fulfilled' },
      { key: 'kp1.refCount', value: '1' },
      { key: 'v1.c.ko2', value: 'R o-1' },
      { key: 'v1.c.o-1', value: 'ko2' },
      { key: 'v1.c.ko3', value: 'R o-2' },
      { key: 'v1.c.o-2', value: 'ko3' },
      { key: 'v1.c.kp1', value: 'R p-1' },
      { key: 'v1.c.p-1', value: 'kp1' },
      { key: 'kp2.state', value: 'fulfilled' },
      { key: 'kp2.refCount', value: '1' },
      { key: 'v1.c.kp2', value: 'R p+5' },
      { key: 'v1.c.p+5', value: 'kp2' },
      { key: 'kp3.state', value: 'fulfilled' },
      { key: 'kp3.refCount', value: '1' },
      { key: 'v1.c.kp3', value: 'R p+6' },
      { key: 'v1.c.p+6', value: 'kp3' },
      { key: 'initialized', value: 'true' },
      { key: 'v2.c.kp2', value: 'R p-1' },
      { key: 'v2.c.p-1', value: 'kp2' },
      {
        key: 'kp2.value',
        value:
          '{"body":"#\\"vat Bob got \\"hello\\" from Alice\\"","slots":[]}',
      },
      { key: 'v3.c.kp3', value: 'R p-1' },
      { key: 'v3.c.p-1', value: 'kp3' },
      {
        key: 'kp3.value',
        value:
          '{"body":"#\\"vat Carol got \\"hello\\" from Alice\\"","slots":[]}',
      },
      { key: 'kp1.value', value: '{"body":"#\\"#undefined\\"","slots":[]}' },
      { key: 'kp4.state', value: 'fulfilled' },
      { key: 'kp4.refCount', value: '1' },
      { key: 'v1.c.kp4', value: 'R p-2' },
      { key: 'v1.c.p-2', value: 'kp4' },
      { key: 'ko4.owner', value: 'v1' },
      { key: 'ko4.refCount', value: '3,3' },
      { key: 'v1.c.ko4', value: 'R o+10' },
      { key: 'v1.c.o+10', value: 'ko4' },
      {
        key: 'kp4.value',
        value: '{"body":"#\\"$0.Alleged: SharedObject\\"","slots":["ko4"]}',
      },
      { key: 'v2.c.ko4', value: 'R o-1' },
      { key: 'v2.c.o-1', value: 'ko4' },
    ];

    const result = parseObjectRegistry(entries);

    const expectedResult: ObjectRegistry = {
      gcActions: '[]',
      reapQueue: '[]',
      terminatedVats: '[]',
      vats: {
        v1: {
          exportedPromises: [
            {
              eref: 'p+5',
              kref: 'kp2' as KRef,
              state: 'fulfilled',
              toVats: ['v2'],
              value: {
                body: '#"vat Bob got "hello" from Alice"',
                slots: [],
              },
            },
            {
              eref: 'p+6',
              kref: 'kp3' as KRef,
              state: 'fulfilled',
              toVats: ['v3'],
              value: {
                body: '#"vat Carol got "hello" from Alice"',
                slots: [],
              },
            },
          ],
          importedObjects: [
            {
              eref: 'o-1',
              fromVat: 'v2',
              kref: 'ko2' as KRef,
              refCount: '1,1',
            },
            {
              eref: 'o-2',
              fromVat: 'v3',
              kref: 'ko3' as KRef,
              refCount: '1,1',
            },
          ],
          importedPromises: [
            {
              eref: 'p-1',
              fromVat: null,
              kref: 'kp1' as KRef,
              state: 'fulfilled',
              value: {
                body: '#"#undefined"',
                slots: [],
              },
            },
            {
              eref: 'p-2',
              fromVat: null,
              kref: 'kp4' as KRef,
              state: 'fulfilled',
              value: {
                body: '#"$0.Alleged: SharedObject"',
                slots: [
                  {
                    eref: 'o+10',
                    kref: 'ko4' as KRef,
                    vat: 'v1',
                  },
                ],
              },
            },
          ],
          overview: {
            bundleSpec: 'http://localhost:3000/sample-vat.bundle',
            name: 'Alice',
          },
          ownedObjects: [
            {
              eref: 'o+0',
              kref: 'ko1' as KRef,
              refCount: '1,1',
              revoked: 'false',
              toVats: [],
            },
            {
              eref: 'o+10',
              kref: 'ko4' as KRef,
              refCount: '3,3',
              revoked: 'false',
              toVats: ['v2'],
            },
          ],
        },
        v2: {
          exportedPromises: [],
          importedObjects: [
            {
              eref: 'o-1',
              fromVat: 'v1',
              kref: 'ko4' as KRef,
              refCount: '3,3',
            },
          ],
          importedPromises: [
            {
              eref: 'p-1',
              fromVat: 'v1',
              kref: 'kp2' as KRef,
              state: 'fulfilled',
              value: {
                body: '#"vat Bob got "hello" from Alice"',
                slots: [],
              },
            },
          ],
          overview: {
            bundleSpec: 'http://localhost:3000/sample-vat.bundle',
            name: 'Bob',
          },
          ownedObjects: [
            {
              eref: 'o+0',
              kref: 'ko2' as KRef,
              refCount: '1,1',
              revoked: 'true',
              toVats: ['v1'],
            },
          ],
        },
        v3: {
          exportedPromises: [],
          importedObjects: [],
          importedPromises: [
            {
              eref: 'p-1',
              fromVat: 'v1',
              kref: 'kp3' as KRef,
              state: 'fulfilled',
              value: {
                body: '#"vat Carol got "hello" from Alice"',
                slots: [],
              },
            },
          ],
          overview: {
            bundleSpec: 'http://localhost:3000/sample-vat.bundle',
            name: 'Carol',
          },
          ownedObjects: [
            {
              eref: 'o+0',
              kref: 'ko3' as KRef,
              refCount: '1,1',
              revoked: 'false',
              toVats: ['v1'],
            },
          ],
        },
      },
      ocapUrls: [],
    };
    expect(result).toStrictEqual(expectedResult);
  });

  it('should parse ocap URLs from promise values', () => {
    const entries = [
      { key: 'gcActions', value: '[]' },
      { key: 'reapQueue', value: '[]' },
      { key: 'vats.terminated', value: '[]' },
      {
        key: 'vatConfig.v1',
        value:
          '{"bundleSpec":"http://localhost:3000/sample-vat.bundle","parameters":{"name":"Alice"}}',
      },
      {
        key: 'vatConfig.v2',
        value:
          '{"bundleSpec":"http://localhost:3000/sample-vat.bundle","parameters":{"name":"Bob"}}',
      },
      // Promise with ocap URL
      { key: 'kp1.state', value: 'fulfilled' },
      {
        key: 'kp1.value',
        value: '{"body":"#\\"ocap://example.com/capability1\\"","slots":[]}',
      },
      { key: 'v1.c.kp1', value: 'R p+1' },
      { key: 'v1.c.p+1', value: 'kp1' },
      // Another promise with ocap URL
      { key: 'kp2.state', value: 'fulfilled' },
      {
        key: 'kp2.value',
        value: '{"body":"#\\"ocap://example.com/capability2\\"","slots":[]}',
      },
      { key: 'v2.c.kp2', value: 'R p+2' },
      { key: 'v2.c.p+2', value: 'kp2' },
      // Promise without ocap URL
      { key: 'kp3.state', value: 'fulfilled' },
      { key: 'kp3.value', value: '{"body":"#\\"regular value\\"","slots":[]}' },
      { key: 'v1.c.kp3', value: 'R p+3' },
      { key: 'v1.c.p+3', value: 'kp3' },
    ];

    const result = parseObjectRegistry(entries);

    expect(result.ocapUrls).toStrictEqual([
      {
        vatId: 'v1',
        promiseId: 'kp1',
        ocapUrl: 'ocap://example.com/capability1',
      },
      {
        vatId: 'v2',
        promiseId: 'kp2',
        ocapUrl: 'ocap://example.com/capability2',
      },
    ]);

    // Verify the promises are still parsed correctly
    expect(result.vats.v1?.exportedPromises).toHaveLength(2);
    expect(result.vats.v1?.exportedPromises[0]).toMatchObject({
      kref: 'kp1',
      eref: 'p+1',
      state: 'fulfilled',
      value: {
        body: '#"ocap://example.com/capability1"',
        slots: [],
      },
    });
  });
});
