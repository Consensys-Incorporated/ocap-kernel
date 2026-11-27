import { beforeEach, describe, expect, it } from 'vitest';

import { buildChain, resolveParties } from './chain.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type { KRef } from '../types.ts';
import { asKRef, asRemoteId, asVatId } from '../../test/branded.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

const owner = asVatId('v1');
const holder = asVatId('v2');
const other = asVatId('v3');
const remote = asRemoteId('r0');
const peerId = '12D3KooWThisKernel';

describe('resolveParties', () => {
  let kernelStore: KernelStore;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    const attest = (
      kind: 'operator' | 'implementer',
      subject: string,
      party: string,
    ): void =>
      kernelStore.addAttestation({
        kind,
        subject,
        party,
        payload: null,
        signature: `${party}-on-${subject}`,
      });
    attest('operator', peerId, 'ed25519:op');
    attest('operator', peerId, 'ed25519:op2');
    attest('operator', 'remote-peer', 'ed25519:remote-op');
    attest('implementer', 'sha256:00', 'ed25519:impl');
    attest('implementer', 'sha256:00', 'ed25519:op');
    kernelStore.setVatBundleHash(owner, 'sha256:00');
    kernelStore.setRemoteInfo(remote, { peerId: 'remote-peer' });
  });

  it.each([
    ['a vat', owner, ['ed25519:op', 'ed25519:op2', 'ed25519:impl']],
    ['a vat with no bundle hash', holder, ['ed25519:op', 'ed25519:op2']],
    ['a remote', remote, ['ed25519:remote-op']],
    ['a remote the store does not know', asRemoteId('r9'), []],
    ['the kernel', 'kernel' as const, ['ed25519:op', 'ed25519:op2']],
  ])('resolves %s', (_what, endpoint, expected) => {
    expect(resolveParties({ kernelStore, endpoint, peerId })).toStrictEqual(
      expected,
    );
  });

  it('resolves no operator for a kernel with no identity', () => {
    expect(
      resolveParties({ kernelStore, endpoint: owner, peerId: undefined }),
    ).toStrictEqual(['ed25519:impl', 'ed25519:op']);
  });
});

describe('buildChain', () => {
  let kernelStore: KernelStore;
  let ko1: KRef;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    ko1 = kernelStore.initKernelObject(owner);
  });

  it('walks conveyances back to the owner, as a graph', () => {
    kernelStore.recordConveyance({
      kref: ko1,
      sender: owner,
      to: holder,
      via: 'message',
      carrier: ko1,
    });
    kernelStore.recordConveyance({
      kref: ko1,
      sender: owner,
      to: other,
      via: 'message',
      carrier: ko1,
    });
    kernelStore.recordConveyance({
      kref: ko1,
      sender: other,
      to: holder,
      via: 'notify',
      carrier: asKRef('kp1'),
    });
    expect(
      buildChain({ kernelStore, kref: ko1, holder, peerId: undefined }),
    ).toStrictEqual({
      kref: ko1,
      owner,
      hops: [
        {
          endpoint: holder,
          parties: [],
          acquisitions: [
            {
              kind: 'conveyance',
              sender: owner,
              via: 'message',
              seq: 1,
            },
            {
              kind: 'conveyance',
              sender: other,
              via: 'notify',
              seq: 3,
            },
          ],
        },
        { endpoint: owner, parties: [], acquisitions: [] },
        {
          endpoint: other,
          parties: [],
          acquisitions: [
            {
              kind: 'conveyance',
              sender: owner,
              via: 'message',
              seq: 2,
            },
          ],
        },
      ],
    });
  });

  it('falls back to the introduction, and stops at the kernel', () => {
    kernelStore.startCrank();
    kernelStore.incrementCrankNumber();
    kernelStore.setCurrentDelivery({ via: 'message', sender: 'kernel' });
    kernelStore.recordIntroduction({ kref: ko1, endpoint: holder });
    kernelStore.endCrank();
    expect(
      buildChain({ kernelStore, kref: ko1, holder, peerId: undefined }),
    ).toStrictEqual({
      kref: ko1,
      owner,
      hops: [
        {
          endpoint: holder,
          parties: [],
          acquisitions: [
            {
              kind: 'introduction',
              sender: 'kernel',
              via: 'message',
              seq: 1,
            },
          ],
        },
        { endpoint: 'kernel', parties: [], acquisitions: [] },
      ],
    });
  });

  it('stops at an introduction with no sender', () => {
    kernelStore.startCrank();
    kernelStore.incrementCrankNumber();
    kernelStore.setCurrentDelivery({ via: 'ocap-url' });
    kernelStore.recordIntroduction({ kref: ko1, endpoint: holder });
    kernelStore.endCrank();
    expect(
      buildChain({ kernelStore, kref: ko1, holder, peerId: undefined }),
    ).toStrictEqual({
      kref: ko1,
      owner,
      hops: [
        {
          endpoint: holder,
          parties: [],
          acquisitions: [
            {
              kind: 'introduction',
              sender: null,
              via: 'ocap-url',
              seq: 1,
            },
          ],
        },
      ],
    });
  });

  it('resolves a remote hop to the operator of its kernel', () => {
    kernelStore.setRemoteInfo(remote, { peerId: 'remote-peer' });
    kernelStore.addAttestation({
      kind: 'operator',
      subject: 'remote-peer',
      party: 'ed25519:remote-op',
      payload: null,
      signature: 'sig',
    });
    kernelStore.recordConveyance({
      kref: ko1,
      sender: owner,
      to: remote,
      via: 'message',
      carrier: ko1,
    });
    kernelStore.recordConveyance({
      kref: ko1,
      sender: remote,
      to: holder,
      via: 'message',
      carrier: ko1,
    });
    expect(
      buildChain({ kernelStore, kref: ko1, holder, peerId: undefined }).hops,
    ).toStrictEqual([
      {
        endpoint: holder,
        parties: [],
        acquisitions: [
          {
            kind: 'conveyance',
            sender: remote,
            via: 'message',
            seq: 2,
          },
        ],
      },
      {
        endpoint: remote,
        parties: ['ed25519:remote-op'],
        acquisitions: [
          {
            kind: 'conveyance',
            sender: owner,
            via: 'message',
            seq: 1,
          },
        ],
      },
      { endpoint: owner, parties: [], acquisitions: [] },
    ]);
  });

  it('is just the owner for the owner', () => {
    expect(
      buildChain({ kernelStore, kref: ko1, holder: owner, peerId: undefined }),
    ).toStrictEqual({
      kref: ko1,
      owner,
      hops: [{ endpoint: owner, parties: [], acquisitions: [] }],
    });
  });
});
