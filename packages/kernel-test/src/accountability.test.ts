import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { toHex } from '@metamask/kernel-utils';
import {
  attestationSigningBytes,
  kunser,
  verifyKernelSignature,
} from '@metamask/ocap-kernel';
import type {
  AccountabilityRecord,
  AttestationClaim,
  Chain,
  DeliveryRecord,
  IntroductionRecord,
  Kernel,
  KRef,
  Receipt,
  VatId,
} from '@metamask/ocap-kernel';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

/**
 * Make a party of the built-in `ed25519` scheme.
 *
 * @param seedByte - The byte the 32-byte seed is filled with.
 * @returns The party and a way to attest as it.
 */
const makeParty = async (
  seedByte: number,
): Promise<{
  party: string;
  attest: <Claim extends Omit<AttestationClaim, 'party'>>(
    claim: Claim,
  ) => Promise<Claim & { party: string; signature: string }>;
}> => {
  const keyPair = await generateKeyPairFromSeed(
    'Ed25519',
    new Uint8Array(32).fill(seedByte),
  );
  const party = `ed25519:${toHex(keyPair.publicKey.raw)}`;
  return {
    party,
    attest: async (claim) => {
      const full = { ...claim, party };
      return {
        ...full,
        signature: toHex(await keyPair.sign(attestationSigningBytes(full))),
      };
    },
  };
};

/**
 * This kernel's peer ID.
 *
 * @param kernel - The kernel.
 * @returns Its peer ID.
 */
const peerIdOf = async (kernel: Kernel): Promise<string> => {
  await kernel.initIdentity();
  const { remoteComms } = await kernel.getStatus();
  if (remoteComms?.state !== 'identity-only') {
    throw Error('kernel has no identity');
  }
  return remoteComms.peerId;
};

const launch = async (): Promise<{
  kernel: Kernel;
  tracker: KRef;
  holder: KRef;
  trackerVat: VatId;
  holderVat: VatId;
}> => {
  const { logger } = makeTestLogger();
  const kernel = await makeKernel(
    await makeSQLKernelDatabase({}),
    true,
    logger,
  );
  const bundleSpec = getBundleSpec('accountability-vat');
  const { subclusterId, vatRootKrefs } = await kernel.launchSubcluster({
    bootstrap: 'tracker',
    services: ['accountability'],
    vats: {
      tracker: { bundleSpec, parameters: {} },
      holder: { bundleSpec, parameters: {} },
    },
  });
  const [trackerVat, holderVat] = kernel.getSubclusterVats(subclusterId) as [
    VatId,
    VatId,
  ];
  return {
    kernel,
    tracker: vatRootKrefs.tracker as KRef,
    holder: vatRootKrefs.holder as KRef,
    trackerVat,
    holderVat,
  };
};

const call = async (
  kernel: Kernel,
  target: KRef,
  method: string,
  args: unknown[] = [],
): Promise<unknown> => kunser(await kernel.queueMessage(target, method, args));

describe('accountability', () => {
  it('records what is done with a tracked object, and lets its owner read it back', async () => {
    const { kernel, tracker, trackerVat, holderVat } = await launch();
    await call(kernel, tracker, 'track');
    await call(kernel, tracker, 'handOver');
    const history = (await call(
      kernel,
      tracker,
      'history',
    )) as AccountabilityRecord[];

    const thing = history[0]?.kind === 'conveyance' ? history[0].kref : '';
    expect(history).toStrictEqual([
      // `handOver` carried the thing to the holder, its first sight of it.
      expect.objectContaining({
        kind: 'conveyance',
        kref: thing,
        sender: trackerVat,
        to: holderVat,
        via: 'message',
      }),
      expect.objectContaining({
        kind: 'introduction',
        kref: thing,
        endpoint: holderVat,
        sender: trackerVat,
        via: 'message',
      }),
      // The holder's poke.
      expect.objectContaining({
        kind: 'delivery',
        target: thing,
        targetEndpoint: trackerVat,
        sender: holderVat,
        method: 'poke',
        slots: [],
      }),
      // Asking for the history carried the thing to the kernel.
      expect.objectContaining({
        kind: 'conveyance',
        kref: thing,
        sender: trackerVat,
        to: 'kernel',
        via: 'message',
      }),
    ]);
    expect(history[2]).not.toHaveProperty('args');
    expect(history.every((record) => record.witness === 'kernel')).toBe(true);
  });

  it('keeps the arguments when asked, and keeps the records once untracked', async () => {
    const { kernel, tracker } = await launch();
    await call(kernel, tracker, 'track', [{ recordArgs: true }]);
    await call(kernel, tracker, 'handOver');
    await call(kernel, tracker, 'untrack');
    await call(kernel, tracker, 'handOver');

    const {
      payload: { records: deliveries },
    } = await kernel.exportAccountabilityRecords({ kind: 'delivery' });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toStrictEqual(
      expect.objectContaining({
        method: 'poke',
        args: { body: '#["poke",[]]', slots: [] },
      }),
    );
  });

  it("records each endpoint's first acquisition of each object", async () => {
    const { kernel, tracker, holder, trackerVat } = await launch();
    const introductions = (
      await kernel.exportAccountabilityRecords({ kind: 'introduction' })
    ).payload.records as IntroductionRecord[];
    const acquired = introductions.map((record) => [
      record.endpoint,
      record.kref,
      record.sender,
      record.via,
    ]);
    // The bootstrap message handed the tracker the holder's root.
    expect(acquired).toContainEqual([trackerVat, holder, 'kernel', 'message']);
    // Its own root is not an acquisition.
    expect(acquired.map(([, kref]) => kref)).not.toContain(tracker);
  });

  it('signs a receipt for the delivery the caller is handling', async () => {
    const { kernel, tracker, trackerVat, holderVat } = await launch();
    await call(kernel, tracker, 'track');
    await call(kernel, tracker, 'handOver');
    const receipt = (await call(kernel, tracker, 'receipt')) as Receipt;
    expect(receipt.payload).toStrictEqual({
      kind: 'receipt',
      delivery: expect.objectContaining({
        kind: 'delivery',
        targetEndpoint: trackerVat,
        sender: holderVat,
        method: 'receipt',
      }),
    });
    expect(receipt.signer).toBe(await peerIdOf(kernel));
    expect(await verifyKernelSignature(receipt)).toBe(true);
  });

  it("records an act the host attributes to a party, with the party's intent", async () => {
    const { kernel, tracker } = await launch();
    const alice = await makeParty(7);
    const intent = await alice.attest({
      kind: 'intent',
      subject: tracker,
      payload: { method: 'handOver', nonce: '1' },
    });
    await kernel.queueMessage(tracker, 'handOver', [], {
      onBehalfOf: alice.party,
      intent,
    });
    await expect(
      kernel.queueMessage(tracker, 'handOver', [], {
        intent: { ...intent, subject: 'ko1' },
      }),
    ).rejects.toThrow('does not check');

    const {
      payload: { records },
    } = await kernel.exportAccountabilityRecords({ kind: 'delivery' });
    expect(records).toStrictEqual([
      expect.objectContaining({
        target: tracker,
        sender: 'kernel',
        method: 'handOver',
        onBehalfOf: alice.party,
        intent,
      }),
    ]);
  });

  it('traces what a delivery to a tracked object goes on to cause', async () => {
    const { kernel, tracker, holder, trackerVat, holderVat } = await launch();
    await call(kernel, tracker, 'track', [{ trace: {} }]);
    await call(kernel, tracker, 'handOver');
    const {
      payload: { records },
    } = await kernel.exportAccountabilityRecords({ kind: 'delivery' });
    const poke = records.find(
      (record) => record.kind === 'delivery' && record.method === 'poke',
    ) as DeliveryRecord;
    const traceId = poke.traceId as string;
    const trace = (await call(kernel, tracker, 'trace', [
      traceId,
    ])) as AccountabilityRecord[];
    expect(
      trace.map((record) => [
        record.kind,
        'hop' in record ? record.hop : undefined,
        record,
      ]),
    ).toStrictEqual([
      // The poke, which started the trace.
      ['delivery', 0, expect.objectContaining({ sender: holderVat })],
      // The poke's answer, told to the holder.
      ['resolution', 1, expect.objectContaining({ endpoint: holderVat })],
      // The holder's answer to `receive`, told to the tracker.
      ['resolution', 2, expect.objectContaining({ endpoint: trackerVat })],
    ]);
    expect(await call(kernel, holder, 'trace', [traceId])).toStrictEqual(trace);
  });

  it('traces an act the host asks to have traced, as far as the hop limit', async () => {
    const { kernel, tracker, holder, trackerVat, holderVat } = await launch();
    await kernel.queueMessage(tracker, 'handOver', [], {
      trace: { hopLimit: 2 },
    });
    const {
      payload: { records },
    } = await kernel.exportAccountabilityRecords({ kind: 'delivery' });
    expect(
      (records as DeliveryRecord[]).map(({ hop, target, method }) => [
        hop,
        target,
        method,
      ]),
    ).toStrictEqual([
      [0, tracker, 'handOver'],
      [1, holder, 'receive'],
    ]);
    const [first] = records as DeliveryRecord[];
    expect(
      await kernel.exportAccountabilityRecords({
        trace: first?.traceId as string,
      }),
    ).toStrictEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          records: [
            expect.objectContaining({ targetEndpoint: trackerVat }),
            expect.objectContaining({ targetEndpoint: holderVat }),
          ],
        }),
      }),
    );
  });

  it('names each vat by the hash of its bundle', async () => {
    const { kernel, trackerVat } = await launch();
    const bundle = await readFile(new URL(getBundleSpec('accountability-vat')));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bundle);
    expect(kernel.getVatBundleHash(trackerVat)).toBe(
      `sha256:${toHex(new Uint8Array(digest))}`,
    );
  });

  it('resolves a chain of custody to the parties answerable for each holder', async () => {
    const { kernel, tracker, holder, trackerVat, holderVat } = await launch();
    const operator = await makeParty(8);
    const implementer = await makeParty(9);
    const peerId = await peerIdOf(kernel);
    await kernel.attest(
      await operator.attest({
        kind: 'operator',
        subject: peerId,
        payload: null,
      }),
    );
    await kernel.attest(
      await implementer.attest({
        kind: 'implementer',
        subject: kernel.getVatBundleHash(trackerVat) as string,
        payload: { name: 'accountability-vat' },
      }),
    );
    await call(kernel, tracker, 'track');
    await call(kernel, tracker, 'handOver');

    const chain = (await call(kernel, holder, 'chain')) as Chain;
    expect(chain).toStrictEqual({
      kref: expect.stringMatching(/^ko\d+$/u),
      owner: trackerVat,
      hops: [
        {
          endpoint: holderVat,
          // The holder runs the same bundle, so it has the same implementer.
          parties: [operator.party, implementer.party],
          acquisitions: [
            expect.objectContaining({ kind: 'conveyance', sender: trackerVat }),
          ],
        },
        {
          endpoint: trackerVat,
          parties: [operator.party, implementer.party],
          acquisitions: [],
        },
      ],
    });

    const exported = await kernel.exportAccountabilityRecords({
      kind: 'delivery',
    });
    expect(exported.payload.attestations.map(({ kind }) => kind)).toStrictEqual(
      ['implementer', 'operator'],
    );
    expect(await verifyKernelSignature(exported)).toBe(true);
    expect(
      (exported.payload.records as DeliveryRecord[]).map(
        ({ method }) => method,
      ),
    ).toStrictEqual(['poke']);
  });
});
