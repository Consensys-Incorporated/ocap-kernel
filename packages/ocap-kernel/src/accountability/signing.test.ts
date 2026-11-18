import { describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  makeKernelSigner,
  verifyKernelSignature,
} from './signing.ts';
import { makeKernelStore } from '../store/index.ts';
import { seedIdentity } from '../../test/identity.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

describe('canonicalJson', () => {
  it.each([
    [
      'sorts keys at every depth',
      { b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] },
      '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    ],
    [
      'leaves out undefined properties',
      { a: undefined, b: null },
      '{"b":null}',
    ],
    ['keeps primitives as JSON', ['x', 1, true, null], '["x",1,true,null]'],
  ])('%s', (_what, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });
});

describe('makeKernelSigner', () => {
  it('signs with the identity in the store, and the signature checks against the peer ID', async () => {
    const kdb = makeMapKernelDatabase();
    const peerId = await seedIdentity(kdb.kernelKVStore);
    const ensureIdentity = vi.fn();
    const signer = makeKernelSigner({
      kernelStore: makeKernelStore(kdb),
      ensureIdentity,
    });
    const signed = await signer.sign({ hello: 'world' });
    expect(signed).toStrictEqual({
      payload: { hello: 'world' },
      signer: peerId,
      incarnationId: expect.any(String),
      signature: expect.stringMatching(/^[0-9a-f]{128}$/u),
    });
    expect(await signer.getPeerId()).toBe(peerId);
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect(await verifyKernelSignature(signed)).toBe(true);
  });

  it('initializes the identity if the store has none', async () => {
    const kdb = makeMapKernelDatabase();
    const ensureIdentity = vi.fn(async () => {
      await seedIdentity(kdb.kernelKVStore, 3);
    });
    const signer = makeKernelSigner({
      kernelStore: makeKernelStore(kdb),
      ensureIdentity,
    });
    expect(await signer.getPeerId()).toBe(kdb.kernelKVStore.get('peerId'));
    expect(ensureIdentity).toHaveBeenCalledTimes(1);
  });
});

describe('verifyKernelSignature', () => {
  const makeSigned = async (): Promise<
    Awaited<ReturnType<ReturnType<typeof makeKernelSigner>['sign']>>
  > => {
    const kdb = makeMapKernelDatabase();
    await seedIdentity(kdb.kernelKVStore);
    const signer = makeKernelSigner({
      kernelStore: makeKernelStore(kdb),
      ensureIdentity: vi.fn(),
    });
    return signer.sign({ n: 1 });
  };

  it.each([
    ['a changed payload', { payload: { n: 2 } }],
    ['a changed incarnation', { incarnationId: 'other' }],
    ['a signer that is not a peer ID', { signer: 'nobody' }],
  ])('rejects %s', async (_what, change) => {
    const signed = await makeSigned();
    expect(await verifyKernelSignature({ ...signed, ...change })).toBe(false);
  });

  it('rejects another peer as the signer', async () => {
    const signed = await makeSigned();
    const other = await seedIdentity(makeMapKernelDatabase().kernelKVStore, 9);
    expect(await verifyKernelSignature({ ...signed, signer: other })).toBe(
      false,
    );
  });
});
