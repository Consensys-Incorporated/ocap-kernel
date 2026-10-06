import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { join, narrow, pathUnder } from '@metamask/kernel-utils';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * `stat` is named here although the delta drops it, so that a probe can try to
 * call it.
 */
type Store = {
  read: (segments: string[]) => Promise<string>;
  stat: (segments: string[]) => Promise<string>;
  copy: (from: string[], to: string[]) => Promise<string>;
};

/**
 * Report an invocation's outcome, so a caller can tell a refusal from a result
 * without matching on a rejection.
 *
 * @param call - The invocation to attempt.
 * @returns `ok:<result>`, or `rejected:<message>`.
 */
const probe = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    return `ok:${String(await call())}`;
  } catch (error) {
    return `rejected:${(error as Error).message}`;
  }
};

/**
 * Build function for a vat that narrows capabilities it builds itself.
 *
 * @returns The root object for the new vat.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function buildRootObject() {
  const base = makeExo(
    'Store',
    M.interface('Store', {
      read: M.call(M.arrayOf(M.string())).returns(M.string()),
      stat: M.call(M.arrayOf(M.string())).returns(M.string()),
      copy: M.call(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
        M.string(),
      ),
    }),
    {
      read: (segments: string[]) => `read:${segments.join('/')}`,
      stat: (segments: string[]) => `stat:${segments.join('/')}`,
      copy: (from: string[], to: string[]) =>
        `copy:${from.join('/')}->${to.join('/')}`,
    },
  );

  const looseBase = makeDefaultExo('LooseStore', {
    read: (segments: string[]) => `loose:${segments.join('/')}`,
  });

  const underData = { read: [pathUnder(['srv', 'data'])] };

  /**
   * Join a narrowing that copies within `srv/data` with one that copies within
   * `srv/logs`.
   *
   * @returns The join.
   */
  const joinCopies = async (): Promise<Store> => {
    const within = async (name: string, prefix: string[]): Promise<Store> =>
      narrow<Store>({
        name,
        base,
        delta: { copy: [pathUnder(prefix), pathUnder(prefix)] },
      });
    return join<Store>({
      name: 'DataOrLogCopier',
      refs: [
        await within('DataCopier', ['srv', 'data']),
        await within('LogCopier', ['srv', 'logs']),
      ],
    });
  };

  /**
   * Narrow the join of copiers so that no destination segment is `secret`.
   *
   * @returns The narrowed join.
   */
  const narrowJoinedCopies = async (): Promise<Store> =>
    narrow<Store>({
      name: 'DataOrLogCopierNoSecrets',
      base: await joinCopies(),
      delta: {
        copy: [undefined, M.arrayOf(M.not(M.eq('secret')))],
      },
    });

  return makeDefaultExo('root', {
    bootstrap: () => 'narrowing-vat',

    probeNarrowed: async (method: 'read' | 'stat', segments: string[]) => {
      const scoped = await narrow<Store>({
        name: 'DataStore',
        base,
        delta: underData,
      });
      return probe(async () => E(scoped)[method](segments));
    },

    probeJoined: async (segments: string[]) => {
      const data = await narrow<Store>({
        name: 'DataStore',
        base,
        delta: underData,
      });
      const logs = await narrow<Store>({
        name: 'LogStore',
        base,
        delta: { read: [pathUnder(['srv', 'logs'])] },
      });
      const both = await join<Store>({
        name: 'DataAndLogStore',
        refs: [data, logs],
      });
      return probe(async () => E(both).read(segments));
    },

    probeJoinedCopy: async (from: string[], to: string[]) => {
      const both = await joinCopies();
      return probe(async () => E(both).copy(from, to));
    },

    probeNarrowedJoin: async (from: string[], to: string[]) => {
      const narrowed = await narrowJoinedCopies();
      return probe(async () => E(narrowed).copy(from, to));
    },

    // Joining with `base` succeeds only if the narrowed join's record names
    // `base` itself rather than the join it narrowed, and `base` then absorbs.
    probeNarrowedJoinWithBase: async (from: string[], to: string[]) => {
      const flattened = await join<Store>({
        name: 'Flattened',
        refs: [await narrowJoinedCopies(), base],
      });
      return probe(async () => E(flattened).copy(from, to));
    },

    probeDefaultGuarded: async (segments: string[]) => {
      const scoped = await narrow<Store>({
        name: 'LooseDataStore',
        base: looseBase,
        delta: underData,
      });
      return probe(async () => E(scoped).read(segments));
    },
  });
}
