import { Fail } from '@endo/errors';
import type { KVStore } from '@metamask/kernel-store';
import type { Logger } from '@metamask/logger';
import { assert } from '@metamask/superstruct';

import type { RelayEntry } from '../types.ts';
import { RelayEntryStruct } from '../types.ts';

/**
 * Get methods for managing relay entries and remote identity values in the
 * kernel store.
 *
 * @param ctx - Store context subset required by relay methods.
 * @param ctx.kv - The key/value store for persistence.
 * @param ctx.logger - Optional logger for migration and diagnostic events.
 * @returns An object with relay and remote identity store methods.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function getRelayMethods(ctx: {
  kv: KVStore;
  logger?: Logger | undefined;
}) {
  const { kv, logger } = ctx;

  /**
   * Parse the knownRelays JSON string from storage, wrapping errors with
   * a contextual message.
   *
   * @param raw - The raw JSON string to parse.
   * @returns The parsed value.
   */
  function parseStoredJSON(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw Error(
        `Failed to parse knownRelays from store (value may be corrupted): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  /**
   * Read relay entries from storage, auto-migrating from the legacy
   * `string[]` format if necessary.
   *
   * @returns The relay entries.
   */
  function getRelayEntries(): RelayEntry[] {
    const raw = kv.get('knownRelays');
    if (!raw) {
      return [];
    }

    const parsed: unknown = parseStoredJSON(raw);
    if (!Array.isArray(parsed)) {
      // oxlint-disable-next-line typescript/only-throw-error -- Fail returns never; throw is needed for TS narrowing
      throw Fail`knownRelays must be an array`;
    }

    // Migrate legacy string[] format -> RelayEntry[] (persisted back to storage)
    if (parsed.length > 0 && typeof parsed[0] === 'string') {
      if (!parsed.every((entry: unknown) => typeof entry === 'string')) {
        Fail`knownRelays legacy format must be all strings`;
      }
      const migrated: RelayEntry[] = (parsed as string[]).map((addr) => ({
        addr,
        lastSeen: 0,
        isBootstrap: false,
      }));
      kv.set('knownRelays', JSON.stringify(migrated));
      logger?.log(
        `Migrated ${migrated.length} legacy relay entries to RelayEntry format`,
      );
      return migrated;
    }

    // Validate each entry against the RelayEntry schema (entries deserialized
    // from storage may have been written by an older version or corrupted)
    for (const entry of parsed) {
      assert(entry, RelayEntryStruct, 'Invalid stored relay entry');
    }
    return parsed as RelayEntry[];
  }

  /**
   * Persist relay entries to storage. Validates each entry against the
   * {@link RelayEntryStruct} schema before writing. Callers are responsible
   * for enforcing pool caps (e.g. `maxKnownRelays`) before calling this
   * method.
   *
   * @param entries - The relay entries to persist.
   */
  function setRelayEntries(entries: RelayEntry[]): void {
    for (const entry of entries) {
      assert(entry, RelayEntryStruct, 'Invalid relay entry');
    }
    kv.set('knownRelays', JSON.stringify(entries));
  }

  /**
   * Convenience: return only relay addresses (for ConnectionFactory, etc.).
   *
   * @returns The relay addresses.
   */
  function getKnownRelayAddresses(): string[] {
    return getRelayEntries().map((entry) => entry.addr);
  }

  // Remote identity KV accessors

  /**
   * Get a remote identity value from the store.
   *
   * @param key - The identity key to retrieve.
   * @returns The stored value, or undefined if not set.
   */
  function getRemoteIdentityValue(
    key: 'peerId' | 'keySeed' | 'ocapURLKey',
  ): string | undefined {
    return kv.get(key);
  }

  /**
   * Get a required remote identity value from the store.
   *
   * @param key - The identity key to retrieve.
   * @returns The stored value.
   * @throws If the key is not set.
   */
  function getRemoteIdentityValueRequired(
    key: 'peerId' | 'keySeed' | 'ocapURLKey',
  ): string {
    return kv.getRequired(key);
  }

  /**
   * Set a remote identity value in the store.
   *
   * @param key - The identity key to set.
   * @param value - The value to store.
   */
  function setRemoteIdentityValue(
    key: 'peerId' | 'keySeed' | 'ocapURLKey',
    value: string,
  ): void {
    kv.set(key, value);
  }

  return {
    getRelayEntries,
    setRelayEntries,
    getKnownRelayAddresses,
    getRemoteIdentityValue,
    getRemoteIdentityValueRequired,
    setRemoteIdentityValue,
  };
}
