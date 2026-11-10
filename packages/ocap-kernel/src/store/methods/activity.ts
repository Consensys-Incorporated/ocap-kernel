import type { KVStore } from '@metamask/kernel-store';

/** Minimum gap in milliseconds to consider a cross-incarnation wake (1 hour). */
const WAKE_THRESHOLD_MS = 3_600_000;

/**
 * Get methods for tracking kernel activity and detecting cross-incarnation
 * wake events.
 *
 * @param kv - The key/value store for persistence.
 * @returns An object with activity-tracking methods.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getActivityMethods(kv: KVStore) {
  /**
   * Detect whether the kernel is resuming after a period of system sleep that
   * spanned a process restart. Compares the persisted `lastActiveTime` with
   * the current time and records the current time as the new active timestamp.
   *
   * @returns `true` if a cross-incarnation wake event was detected.
   */
  function detectWake(): boolean {
    const lastActiveTimeStr = kv.get('lastActiveTime');
    const lastActiveTime = lastActiveTimeStr
      ? Number(lastActiveTimeStr)
      : undefined;
    const wakeDetected =
      lastActiveTime !== undefined &&
      !Number.isNaN(lastActiveTime) &&
      Date.now() - lastActiveTime > WAKE_THRESHOLD_MS;
    kv.set('lastActiveTime', String(Date.now()));
    return wakeDetected;
  }

  /**
   * Record the current time as the last active timestamp.
   * Called on graceful shutdown to provide the most recent timestamp.
   */
  function recordLastActiveTime(): void {
    kv.set('lastActiveTime', String(Date.now()));
  }

  return { detectWake, recordLastActiveTime };
}
