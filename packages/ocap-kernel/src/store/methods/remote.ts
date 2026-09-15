import { getBaseMethods } from './base.ts';
import type { RemoteInfo } from '../../remotes/types.ts';
import type { RemoteId } from '../../types.ts';
import type { StoreContext } from '../types.ts';

export type RemoteRecord = {
  remoteId: RemoteId;
  remoteInfo: RemoteInfo;
};

/**
 * Sequence tracking state for a remote.
 */
export type RemoteSeqState = {
  nextSendSeq: number;
  highestReceivedSeq: number;
  startSeq: number;
};

const REMOTE_INFO_BASE = 'remote.';
const REMOTE_INFO_BASE_LEN = REMOTE_INFO_BASE.length;
const REMOTE_SEQ_BASE = 'remoteSeq.';
const REMOTE_PENDING_BASE = 'remotePending.';
const PEER_INCARNATION_BASE = 'peerIncarnation.';

/**
 * Get a kernel store object that provides functionality for managing remote records.
 *
 * @param ctx - The store context.
 * @returns A vat store object that maps various persistent kernel data
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getRemoteMethods(ctx: StoreContext) {
  const { kv } = ctx;
  const { getPrefixedKeys } = getBaseMethods(ctx.kv);

  /**
   * Generator that yields the info about active remotes.
   *
   * @yields a series of remote records for all active remotes.
   */
  function* getAllRemoteRecords(): Generator<RemoteRecord> {
    for (const remoteKey of getPrefixedKeys(REMOTE_INFO_BASE)) {
      const remoteId = remoteKey.slice(REMOTE_INFO_BASE_LEN) as RemoteId;
      const remoteInfo = getRemoteInfo(remoteId);
      yield { remoteId, remoteInfo };
    }
  }

  /**
   * Fetch the stored info about a remote.
   *
   * @param remoteId - The remote whose info is sought.
   *
   * @returns the info for the given remote.
   */
  function getRemoteInfo(remoteId: RemoteId): RemoteInfo {
    return JSON.parse(
      kv.getRequired(`${REMOTE_INFO_BASE}${remoteId}`),
    ) as RemoteInfo;
  }

  /**
   * Store the info for a remote.
   *
   * @param remoteID - The remote whose info is to be set.
   * @param remoteInfo - The info to write.
   */
  function setRemoteInfo(remoteID: RemoteId, remoteInfo: RemoteInfo): void {
    kv.set(`${REMOTE_INFO_BASE}${remoteID}`, JSON.stringify(remoteInfo));
  }

  /**
   * Delete the info for a remote, including its persisted peer-incarnation
   * record. Read the info before deleting so we have the peerId to scope
   * the peerIncarnation cleanup; otherwise stale `peerIncarnation.{peerId}`
   * entries would survive remote teardown and a re-established remote with
   * the same peerId would mis-classify its first handshake as a restart.
   *
   * Corrupt JSON in `remote.{remoteID}` is logged and swallowed so the
   * remaining cleanup steps still run — losing the (already-untrustworthy)
   * peerIncarnation row is preferable to leaving the corrupt entry stuck.
   *
   * @param remoteID - The remote whose info is to be removed.
   */
  function deleteRemoteInfo(remoteID: RemoteId): void {
    const infoKey = `${REMOTE_INFO_BASE}${remoteID}`;
    const rawInfo = kv.get(infoKey);
    if (rawInfo !== undefined) {
      try {
        const { peerId } = JSON.parse(rawInfo) as RemoteInfo;
        kv.delete(`${PEER_INCARNATION_BASE}${peerId}`);
      } catch (parseError) {
        ctx.logger?.error(
          `deleteRemoteInfo: corrupt remote info for ${remoteID}, ` +
            `proceeding without peerIncarnation cleanup`,
          parseError,
        );
      }
    }
    kv.delete(infoKey);
    deleteRemotePendingState(remoteID);
  }

  // --- Sequence/ACK persistence methods ---

  /**
   * Get the sequence tracking state for a remote.
   *
   * @param remoteId - The remote whose seq state is sought.
   * @returns The seq state, or undefined if not yet persisted.
   */
  function getRemoteSeqState(remoteId: RemoteId): RemoteSeqState | undefined {
    const prefix = `${REMOTE_SEQ_BASE}${remoteId}.`;
    const nextSendSeqStr = kv.get(`${prefix}nextSendSeq`);
    const highestReceivedSeqStr = kv.get(`${prefix}highestReceivedSeq`);
    const startSeqStr = kv.get(`${prefix}startSeq`);

    // If none of the keys exist, there's no persisted state
    if (
      nextSendSeqStr === undefined &&
      highestReceivedSeqStr === undefined &&
      startSeqStr === undefined
    ) {
      return undefined;
    }

    return {
      nextSendSeq: nextSendSeqStr === undefined ? 0 : Number(nextSendSeqStr),
      highestReceivedSeq:
        highestReceivedSeqStr === undefined ? 0 : Number(highestReceivedSeqStr),
      startSeq: startSeqStr === undefined ? 0 : Number(startSeqStr),
    };
  }

  /**
   * Set the next outgoing sequence number for a remote.
   *
   * @param remoteId - The remote whose state is to be updated.
   * @param value - The value to set.
   */
  function setRemoteNextSendSeq(remoteId: RemoteId, value: number): void {
    kv.set(`${REMOTE_SEQ_BASE}${remoteId}.nextSendSeq`, String(value));
  }

  /**
   * Set the highest received sequence number for a remote.
   *
   * @param remoteId - The remote whose state is to be updated.
   * @param value - The value to set.
   */
  function setRemoteHighestReceivedSeq(
    remoteId: RemoteId,
    value: number,
  ): void {
    kv.set(`${REMOTE_SEQ_BASE}${remoteId}.highestReceivedSeq`, String(value));
  }

  /**
   * Set the start sequence number (first pending message) for a remote.
   *
   * @param remoteId - The remote whose state is to be updated.
   * @param value - The value to set.
   */
  function setRemoteStartSeq(remoteId: RemoteId, value: number): void {
    kv.set(`${REMOTE_SEQ_BASE}${remoteId}.startSeq`, String(value));
  }

  /**
   * Get a pending message by remote and sequence number.
   *
   * @param remoteId - The remote to get the message for.
   * @param seq - The sequence number of the message.
   * @returns The pending message string, or undefined if not found.
   */
  function getPendingMessage(
    remoteId: RemoteId,
    seq: number,
  ): string | undefined {
    const key = `${REMOTE_PENDING_BASE}${remoteId}.${seq}`;
    return kv.get(key);
  }

  /**
   * Store a pending message.
   *
   * @param remoteId - The remote to store the message for.
   * @param seq - The sequence number of the message.
   * @param messageString - The serialized message to store.
   */
  function setPendingMessage(
    remoteId: RemoteId,
    seq: number,
    messageString: string,
  ): void {
    const key = `${REMOTE_PENDING_BASE}${remoteId}.${seq}`;
    kv.set(key, messageString);
  }

  /**
   * Delete a pending message entry.
   *
   * @param remoteId - The remote to delete the message for.
   * @param seq - The sequence number of the message to delete.
   */
  function deletePendingMessage(remoteId: RemoteId, seq: number): void {
    const key = `${REMOTE_PENDING_BASE}${remoteId}.${seq}`;
    kv.delete(key);
  }

  /**
   * Delete all pending state for a remote (seq state + all pending messages).
   * Called when a remote relationship is terminated.
   *
   * @param remoteId - The remote whose pending state is to be deleted.
   */
  function deleteRemotePendingState(remoteId: RemoteId): void {
    // Delete seq state
    const seqPrefix = `${REMOTE_SEQ_BASE}${remoteId}.`;
    kv.delete(`${seqPrefix}nextSendSeq`);
    kv.delete(`${seqPrefix}highestReceivedSeq`);
    kv.delete(`${seqPrefix}startSeq`);

    // Delete all pending messages
    const pendingPrefix = `${REMOTE_PENDING_BASE}${remoteId}.`;
    for (const key of getPrefixedKeys(pendingPrefix)) {
      kv.delete(key);
    }
  }

  /**
   * Delete orphan pending messages (messages with seq < startSeq).
   * Called during recovery to clean up messages left behind by crashes
   * during ACK processing.
   *
   * @param remoteId - The remote whose orphans are to be cleaned.
   * @param startSeq - The current start sequence; messages below this are orphans.
   * @returns The number of orphan messages deleted.
   */
  function cleanupOrphanMessages(remoteId: RemoteId, startSeq: number): number {
    const pendingPrefix = `${REMOTE_PENDING_BASE}${remoteId}.`;
    const prefixLen = pendingPrefix.length;
    let deletedCount = 0;

    for (const key of getPrefixedKeys(pendingPrefix)) {
      const seq = Number(key.slice(prefixLen));
      if (seq < startSeq) {
        kv.delete(key);
        deletedCount += 1;
      }
    }

    return deletedCount;
  }

  /**
   * Get the last observed incarnationId for a peer. This is the value most
   * recently negotiated via handshake; it survives kernel restart so that the
   * receiver can detect a peer restart even when its in-memory PeerStateManager
   * has been rebuilt empty.
   *
   * @param peerId - The peer whose incarnation is sought.
   * @returns The persisted incarnationId, or undefined if none recorded yet.
   */
  function getPeerIncarnation(peerId: string): string | undefined {
    return kv.get(`${PEER_INCARNATION_BASE}${peerId}`);
  }

  /**
   * Persist the most recently observed incarnationId for a peer.
   *
   * @param peerId - The peer to record.
   * @param incarnationId - The observed incarnationId.
   */
  function setPeerIncarnation(peerId: string, incarnationId: string): void {
    kv.set(`${PEER_INCARNATION_BASE}${peerId}`, incarnationId);
  }

  /**
   * Clear all sequence state for a remote (seq counters + all pending messages).
   * Called when a remote peer restarts (incarnation changes) to reset for fresh communication.
   * Unlike deleteRemotePendingState, this does NOT delete the remote relationship itself.
   *
   * @param remoteId - The remote whose sequence state is to be cleared.
   */
  function clearRemoteSeqState(remoteId: RemoteId): void {
    // Delete seq state
    const seqPrefix = `${REMOTE_SEQ_BASE}${remoteId}.`;
    kv.delete(`${seqPrefix}nextSendSeq`);
    kv.delete(`${seqPrefix}highestReceivedSeq`);
    kv.delete(`${seqPrefix}startSeq`);

    // Delete all pending messages
    const pendingPrefix = `${REMOTE_PENDING_BASE}${remoteId}.`;
    for (const key of getPrefixedKeys(pendingPrefix)) {
      kv.delete(key);
    }
  }

  return {
    getAllRemoteRecords,
    getRemoteInfo,
    setRemoteInfo,
    deleteRemoteInfo,
    // Sequence/ACK persistence
    getRemoteSeqState,
    setRemoteNextSendSeq,
    setRemoteHighestReceivedSeq,
    setRemoteStartSeq,
    getPendingMessage,
    setPendingMessage,
    deletePendingMessage,
    deleteRemotePendingState,
    cleanupOrphanMessages,
    clearRemoteSeqState,
    // Peer incarnation persistence
    getPeerIncarnation,
    setPeerIncarnation,
  };
}
