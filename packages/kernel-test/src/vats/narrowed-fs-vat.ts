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
};

/**
 * The fs endowment's shape, claimed here rather than imported from
 * `@metamask/kernel-platforms` so that this file typechecks independently of it.
 *
 * The encoding is required: `readFile` without one resolves a `Buffer`, and no
 * typed array is Passable, so the result could not cross the exo boundary.
 */
type FsExo = {
  readFile: (segments: string[], encoding: string) => Promise<string>;
};

declare const fs: object;

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
 * Build function for a vat that narrows capabilities — one it builds itself, and
 * the `fs` platform endowment.
 *
 * Every `narrow` and `join` sits outside `probe`, so while they are stubs the
 * method rejects instead of reporting `rejected:`. That is what stops a pending
 * case from passing on the stub's own error.
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
    }),
    {
      read: (segments: string[]) => `read:${segments.join('/')}`,
      stat: (segments: string[]) => `stat:${segments.join('/')}`,
    },
  );

  const looseBase = makeDefaultExo('LooseStore', {
    read: (segments: string[]) => `loose:${segments.join('/')}`,
  });

  const underData = { read: [pathUnder(['srv', 'data'])] };

  return makeDefaultExo('root', {
    bootstrap: () => 'narrowed-fs-vat',

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

    probeDefaultGuarded: async (segments: string[]) => {
      const scoped = await narrow<Store>({
        name: 'LooseDataStore',
        base: looseBase,
        delta: underData,
      });
      return probe(async () => E(scoped).read(segments));
    },

    probeFs: async (segments: string[]) =>
      probe(
        async () => (await E(fs as FsExo).readFile(segments, 'utf8')).length,
      ),

    probeFsNarrowed: async (prefix: string[], segments: string[]) => {
      const scoped = await narrow<FsExo>({
        name: 'ScopedFs',
        base: fs,
        delta: { readFile: [pathUnder(prefix)] },
      });
      return probe(
        async () => (await E(scoped).readFile(segments, 'utf8')).length,
      );
    },
  });
}
