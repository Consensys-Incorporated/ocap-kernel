import { GET_INTERFACE_GUARD } from '@endo/exo';
import { M } from '@endo/patterns';
import { describe, it, expect, vi } from 'vitest';

import { constant } from './metadata.ts';
import { makeRemoteSection } from './remote.ts';
import { makeSection } from './section.ts';

// Mirrors the local-E pattern used throughout sheaf tests: the test
// environment has no HandledPromise, so we mock E as a transparent cast.
// With this mock, E(exo) === exo, so [GET_INTERFACE_GUARD] and method calls
// resolve locally against the exo — equivalent to a local CapTP loopback.
vi.mock('@endo/eventual-send', () => ({
  E: (ref: unknown) => ref,
}));

const makeRemoteExo = (tag: string) =>
  makeSection(
    tag,
    M.interface(
      tag,
      {
        greet: M.callWhen(M.string()).returns(M.string()),
        add: M.callWhen(M.number(), M.number()).returns(M.number()),
      },
      { defaultGuards: 'passable' },
    ),
    {
      greet: async (name: string) => `Hello, ${name}!`,
      add: async (a: number, b: number) => a + b,
    },
  );

describe('makeRemoteSection', () => {
  it('fetches the interface guard from the remote ref', async () => {
    const remoteExo = makeRemoteExo('Remote');
    const { exo } = await makeRemoteSection('Wrapper', remoteExo);
    expect(exo[GET_INTERFACE_GUARD]?.()).toStrictEqual(
      remoteExo[GET_INTERFACE_GUARD]?.(),
    );
  });

  it('forwards method calls to the remote ref', async () => {
    const greet = vi.fn(async (name: string) => `Hello, ${name}!`);
    const remoteExo = makeSection(
      'Remote',
      M.interface(
        'Remote',
        { greet: M.callWhen(M.string()).returns(M.string()) },
        { defaultGuards: 'passable' },
      ),
      { greet },
    );

    const { exo } = await makeRemoteSection('Wrapper', remoteExo);
    const wrapper = exo as Record<
      'greet' | 'add',
      (...a: unknown[]) => Promise<unknown>
    >;
    const result = await wrapper.greet('Alice');

    expect(greet).toHaveBeenCalledWith('Alice');
    expect(result).toBe('Hello, Alice!');
  });

  it('forwards all methods declared in the guard', async () => {
    const greet = vi.fn(async (_: string) => '');
    const add = vi.fn(async (a: number, b: number) => a + b);
    const remoteExo = makeSection(
      'Remote',
      M.interface(
        'Remote',
        {
          greet: M.callWhen(M.string()).returns(M.string()),
          add: M.callWhen(M.number(), M.number()).returns(M.number()),
        },
        { defaultGuards: 'passable' },
      ),
      { greet, add },
    );

    const { exo } = await makeRemoteSection('Wrapper', remoteExo);
    const wrapper = exo as Record<
      'greet' | 'add',
      (...a: unknown[]) => Promise<unknown>
    >;
    await wrapper.greet('x');
    await wrapper.add(2, 3);

    expect(greet).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(2, 3);
  });

  it('passes metadata through to the provider', async () => {
    const metadata = constant({ mode: 'remote' as const });
    const { metadata: actual } = await makeRemoteSection(
      'Wrapper',
      makeRemoteExo('Remote'),
      metadata,
    );
    expect(actual).toBe(metadata);
  });

  it('metadata is undefined when not provided', async () => {
    const { metadata } = await makeRemoteSection(
      'Wrapper',
      makeRemoteExo('Remote'),
    );
    expect(metadata).toBeUndefined();
  });
});
