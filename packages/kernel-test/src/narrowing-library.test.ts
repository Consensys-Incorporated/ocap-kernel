import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import type { Pattern } from '@endo/patterns';
import { join, narrow, pathUnder } from '@metamask/kernel-utils';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import { describe, expect, it } from 'vitest';

// These call `narrow` and `join` directly, under the real lockdown this
// package's tests run in, with no kernel or vat.

type Store = {
  read: (segments: string[]) => Promise<string>;
  stat: (segments: string[]) => Promise<string>;
  copy: (from: string[], to: string[]) => Promise<string>;
};

const makeStore = (): object =>
  makeExo(
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

const DATA = pathUnder(['srv', 'data']);
const LOGS = pathUnder(['srv', 'logs']);
const NOT_SECRET: Pattern = M.arrayOf(M.not(M.eq('secret')));

const refusal = (method: string): RegExp => new RegExp(`"${method}"`, 'u');

describe('narrow', () => {
  it('admits calls within its delta and refuses the rest', async () => {
    const scoped = await narrow<Store>({
      name: 'DataStore',
      base: makeStore(),
      delta: { read: [DATA] },
    });

    expect(await E(scoped).read(['srv', 'data', 'x'])).toBe('read:srv/data/x');
    await expect(E(scoped).read(['etc', 'passwd'])).rejects.toThrow(
      refusal('read'),
    );
    await expect(E(scoped).stat(['srv', 'data', 'x'])).rejects.toThrow(/stat/u);
  });

  describe('of a narrowing', () => {
    const narrowTwice = async (): Promise<{ base: object; twice: Store }> => {
      const base = makeStore();
      const once = await narrow<Store>({
        name: 'DataStore',
        base,
        delta: { read: [DATA] },
      });
      const twice = await narrow<Store>({
        name: 'PublicDataStore',
        base: once,
        delta: { read: [NOT_SECRET] },
      });
      return { base, twice };
    };

    it.each([
      { segments: ['srv', 'data', 'x'], admitted: true },
      { segments: ['srv', 'data', 'secret'], admitted: false },
      { segments: ['etc', 'passwd'], admitted: false },
    ])(
      'applies both deltas: read($segments) admitted is $admitted',
      async ({ segments, admitted }) => {
        const { twice } = await narrowTwice();
        const call = E(twice).read(segments);

        expect(
          await call.then(
            () => true,
            () => false,
          ),
        ).toBe(admitted);
      },
    );

    it('refuses to restore a method the first narrowing dropped', async () => {
      const once = await narrow<Store>({
        name: 'DataStore',
        base: makeStore(),
        delta: { read: [DATA] },
      });

      await expect(
        narrow<Store>({ name: 'StatStore', base: once, delta: { stat: [] } }),
      ).rejects.toThrow(
        'Cannot narrow method "stat": the base has no such method.',
      );
    });

    it('records the original base', async () => {
      const { base, twice } = await narrowTwice();
      const joined = await join<Store>({ name: 'Joined', refs: [twice, base] });

      expect(await E(joined).stat(['etc', 'passwd'])).toBe('stat:etc/passwd');
    });

    it('flattens a promise for a narrowing', async () => {
      const base = makeStore();
      const once = await narrow<Store>({
        name: 'DataStore',
        base,
        delta: { read: [DATA] },
      });
      const twice = await narrow<Store>({
        name: 'PublicDataStore',
        base: Promise.resolve(once),
        delta: { read: [NOT_SECRET] },
      });

      await expect(E(twice).read(['etc', 'passwd'])).rejects.toThrow(
        refusal('read'),
      );
      expect(
        await E(
          await join<Store>({ name: 'Joined', refs: [twice, base] }),
        ).read(['etc', 'passwd']),
      ).toBe('read:etc/passwd');
    });
  });

  it('is unaffected by a change to its delta, before or after it settles', async () => {
    const base = makeStore();
    const delta = { read: [DATA] };

    const pending = narrow<Store>({ name: 'DataStore', base, delta });
    expect(() => {
      delta.read[0] = M.any();
    }).toThrow(TypeError);
    const scoped = await pending;
    expect(() => {
      delta.read.push(M.any());
    }).toThrow(TypeError);

    const joined = await join<Store>({ name: 'Rejoined', refs: [scoped] });
    await expect(E(joined).read(['etc', 'passwd'])).rejects.toThrow(
      refusal('read'),
    );
  });
});

describe('join', () => {
  const joinCopiers = async (
    base: object,
  ): Promise<{ data: Store; logs: Store; both: Store }> => {
    const data = await narrow<Store>({
      name: 'DataCopier',
      base,
      delta: { copy: [DATA, DATA] },
    });
    const logs = await narrow<Store>({
      name: 'LogCopier',
      base,
      delta: { copy: [LOGS, LOGS], read: [LOGS] },
    });
    const both = await join<Store>({ name: 'Copier', refs: [data, logs] });
    return { data, logs, both };
  };

  it.each([
    { from: ['srv', 'data', 'x'], to: ['srv', 'data', 'y'], admitted: true },
    { from: ['srv', 'logs', 'x'], to: ['srv', 'logs', 'y'], admitted: true },
    { from: ['srv', 'data', 'x'], to: ['srv', 'logs', 'y'], admitted: false },
    { from: ['etc', 'x'], to: ['etc', 'y'], admitted: false },
  ])(
    'admits exactly what an operand admits: copy($from, $to) admitted is $admitted',
    async ({ from, to, admitted }) => {
      const { both } = await joinCopiers(makeStore());
      const call = E(both).copy(from, to);

      expect(
        await call.then(
          () => true,
          () => false,
        ),
      ).toBe(admitted);
    },
  );

  it('keeps a method only one operand names at that operand', async () => {
    const { both } = await joinCopiers(makeStore());

    expect(await E(both).read(['srv', 'logs', 'y'])).toBe('read:srv/logs/y');
    await expect(E(both).read(['srv', 'data', 'x'])).rejects.toThrow(
      refusal('read'),
    );
    await expect(E(both).stat(['srv', 'logs', 'y'])).rejects.toThrow(/stat/u);
  });

  it('admits everything the base admits when the base is a ref', async () => {
    const base = makeStore();
    const { data } = await joinCopiers(base);
    const joined = await join<Store>({
      name: 'Everything',
      refs: [data, base],
    });

    expect(await E(joined).copy(['srv', 'data', 'x'], ['etc', 'y'])).toBe(
      'copy:srv/data/x->etc/y',
    );
    expect(await E(joined).stat(['etc', 'passwd'])).toBe('stat:etc/passwd');
  });

  it('refuses refs narrowed from different bases', async () => {
    const { data } = await joinCopiers(makeStore());
    const { logs } = await joinCopiers(makeStore());

    await expect(
      join<Store>({ name: 'Mixed', refs: [data, logs] }),
    ).rejects.toThrow('Cannot join "Mixed": the refs do not share a base.');
  });

  it('refuses a ref that is neither a narrowing nor the base', async () => {
    const { data } = await joinCopiers(makeStore());

    await expect(
      join<Store>({ name: 'Stranger', refs: [data, makeStore()] }),
    ).rejects.toThrow(
      'Cannot join "Stranger": ref 1 was not minted by narrowing.',
    );
  });

  it('refuses a default-guarded base as a ref', async () => {
    const base = makeDefaultExo('LooseStore', {
      read: (segments: string[]) => `loose:${segments.join('/')}`,
    });
    const scoped = await narrow<Store>({
      name: 'LooseDataStore',
      base,
      delta: { read: [DATA] },
    });

    await expect(
      join<Store>({ name: 'Loose', refs: [scoped, base] }),
    ).rejects.toThrow('the base guards methods by default');
  });
});
