import type { Stream, StreamOptions } from '@libp2p/interface';
import { lpStream, streamPair } from '@libp2p/utils';
import { fromString, toString as bufToString } from 'uint8arrays';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the framing bug that motivated switching from
 * `byteStream` to `lpStream`: when the underlying transport (e.g.
 * `@libp2p/webrtc`) splits a single write across multiple frames,
 * `byteStream`'s reader would wake on the first chunk and return a
 * truncated payload. `lpStream` adds a length-prefix so the reader
 * waits until the full message is present and returns it intact.
 *
 * Each test forces chunking by capping the underlying stream's
 * `maxMessageSize` well below the payload size; the abstract stream
 * splits the write into several `message` events on the receiver side.
 * `lpStream.read()` should still return exactly one complete payload
 * per `lpStream.write()`.
 */
describe('lpStream framing over a chunked transport', () => {
  /**
   * Build a connected pair of message streams whose underlying
   * AbstractStream splits any write larger than `chunkSize` bytes into
   * multiple `message` events on the receiving end.
   *
   * @param chunkSize - Per-frame cap to apply to both ends.
   * @returns The outbound/inbound paired streams.
   */
  async function chunkedStreamPair(
    chunkSize: number,
  ): Promise<[Stream, Stream]> {
    // The streams honor `maxMessageSize`, which `StreamOptions` does not declare.
    const options: StreamOptions & { maxMessageSize: number } = {
      maxMessageSize: chunkSize,
    };
    return streamPair({ outbound: options, inbound: options });
  }

  it('reassembles a single payload that the transport splits into many frames', async () => {
    const [outbound, inbound] = await chunkedStreamPair(1024);
    const sender = lpStream(outbound, { maxDataLength: 1024 * 1024 });
    const receiver = lpStream(inbound, { maxDataLength: 1024 * 1024 });

    // 20 KB payload — well above the 1 KB per-frame cap, so the transport
    // will split it into ~20 frames on the receiver side.
    const payload = 'A'.repeat(20_000);
    await sender.write(fromString(payload));

    const received = await receiver.read();
    expect(received.byteLength).toBe(20_000);
    expect(bufToString(received.subarray())).toBe(payload);
  });

  it('preserves message boundaries when several large payloads are sent back-to-back', async () => {
    const [outbound, inbound] = await chunkedStreamPair(2048);
    const sender = lpStream(outbound, { maxDataLength: 1024 * 1024 });
    const receiver = lpStream(inbound, { maxDataLength: 1024 * 1024 });

    const payloads = ['alpha', 'bravo', 'charlie'].map(
      (label) => `${label}:${'x'.repeat(8_000)}`,
    );
    for (const payload of payloads) {
      await sender.write(fromString(payload));
    }

    for (const expected of payloads) {
      const received = await receiver.read();
      expect(bufToString(received.subarray())).toBe(expected);
    }
  });

  it('rejects an inbound message that announces a payload larger than maxDataLength', async () => {
    const [outbound, inbound] = await chunkedStreamPair(1024);
    const sender = lpStream(outbound, { maxDataLength: 1024 * 1024 });
    // Receiver caps inbound at 8 KB to exercise the cross-machine
    // mismatch sirtimid called out: a sender that allows larger messages
    // than the receiver does should produce a clean InvalidDataLengthError
    // on the receiver, not a silent reassembly stall.
    const receiver = lpStream(inbound, { maxDataLength: 8 * 1024 });

    const oversized = fromString('B'.repeat(16_000));
    await sender.write(oversized);

    await expect(receiver.read()).rejects.toThrow(
      /Message length too long|InvalidDataLength/u,
    );
  });
});
