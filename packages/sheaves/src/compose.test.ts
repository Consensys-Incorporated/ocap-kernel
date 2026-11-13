import { describe, it, expect, vi } from 'vitest';

import {
  fallthrough,
  noopPolicy,
  proxyPolicy,
  withFilter,
  withRanking,
} from './compose.ts';
import type { Candidate, Policy, PolicyContext } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Meta = { id: string; cost: number };
type MetaCandidate = Candidate<Partial<Meta>>;

const makeCandidate = (id: string, cost = 0): MetaCandidate => ({
  exo: {} as MetaCandidate['exo'],
  metadata: { id, cost },
});

const ctx: PolicyContext<Meta> = {
  method: 'transfer',
  args: ['alice', 100n],
  constraints: {},
};

/**
 * Drive a policy to exhaustion, simulating a failure after each yielded
 * candidate. Returns all yielded candidates in order and the error arrays
 * the generator received.
 *
 * @param policy - The policy to drive.
 * @param candidates - The candidates to pass to the policy.
 * @param context - The policy context.
 * @returns Yielded candidates and error snapshots received by the generator.
 */
const driveToExhaustion = async (
  policy: Policy<Meta>,
  candidates: MetaCandidate[],
  context: PolicyContext<Meta> = ctx,
): Promise<{ yielded: MetaCandidate[]; receivedErrors: unknown[][] }> => {
  const yielded: MetaCandidate[] = [];
  const receivedErrors: unknown[][] = [];
  const errors: unknown[] = [];
  const gen = policy(candidates, context);
  let next = await gen.next([...errors]);
  while (!next.done) {
    yielded.push(next.value);
    errors.push(new Error(`attempt ${errors.length + 1} failed`));
    receivedErrors.push([...errors]);
    next = await gen.next([...errors]);
  }
  return { yielded, receivedErrors };
};

/**
 * Drive a policy, succeeding on the nth candidate (1-based).
 * Returns the winning candidate.
 *
 * @param policy - The policy to drive.
 * @param candidates - The candidates to pass to the policy.
 * @param successOn - Which attempt number (1-based) should succeed.
 * @param context - The policy context.
 * @returns The candidate that won on attempt `successOn`.
 */
const driveWithSuccessOn = async (
  policy: Policy<Meta>,
  candidates: MetaCandidate[],
  successOn: number,
  context: PolicyContext<Meta> = ctx,
): Promise<MetaCandidate> => {
  const errors: unknown[] = [];
  const gen = policy(candidates, context);
  let attempt = 0;
  let next = await gen.next([...errors]);
  while (!next.done) {
    attempt += 1;
    if (attempt === successOn) {
      await gen.return(undefined);
      return next.value;
    }
    errors.push(new Error(`attempt ${attempt} failed`));
    next = await gen.next([...errors]);
  }
  throw new Error('generator exhausted before success');
};

// ---------------------------------------------------------------------------
// noopPolicy
// ---------------------------------------------------------------------------

describe('noopPolicy', () => {
  it('yields candidates in original order', async () => {
    const candidates = [
      makeCandidate('a'),
      makeCandidate('b'),
      makeCandidate('c'),
    ];
    const { yielded } = await driveToExhaustion(noopPolicy, candidates);
    expect(yielded).toStrictEqual(candidates);
  });

  it('yields nothing when given no candidates', async () => {
    const { yielded } = await driveToExhaustion(noopPolicy, []);
    expect(yielded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// proxyPolicy
// ---------------------------------------------------------------------------

describe('proxyPolicy', () => {
  it('forwards all yielded values from inner generator', async () => {
    const [candidateA, candidateB, candidateC] = [
      makeCandidate('a'),
      makeCandidate('b'),
      makeCandidate('c'),
    ];
    const inner = async function* (): AsyncGenerator<
      MetaCandidate,
      void,
      unknown[]
    > {
      yield candidateA;
      yield candidateB;
      yield candidateC;
    };

    const { yielded } = await driveToExhaustion(() => proxyPolicy(inner()), []);
    expect(yielded).toStrictEqual([candidateA, candidateB, candidateC]);
  });

  it('forwards error arrays down to inner generator', async () => {
    const [candidateA, candidateB] = [makeCandidate('a'), makeCandidate('b')];
    const receivedByInner: unknown[][] = [];

    const inner = async function* (): AsyncGenerator<
      MetaCandidate,
      void,
      unknown[]
    > {
      const errors1: unknown[] = yield candidateA;
      receivedByInner.push(errors1);
      const errors2: unknown[] = yield candidateB;
      receivedByInner.push(errors2);
    };

    await driveToExhaustion(() => proxyPolicy(inner()), []);

    expect(receivedByInner).toHaveLength(2);
    expect(receivedByInner[0]).toHaveLength(1); // one error after first attempt
    expect(receivedByInner[1]).toHaveLength(2); // two errors after second attempt
  });

  it('stops when inner generator is done', async () => {
    const inner = async function* (): AsyncGenerator<
      MetaCandidate,
      void,
      unknown[]
    > {
      // immediately done
    };

    const { yielded } = await driveToExhaustion(() => proxyPolicy(inner()), []);
    expect(yielded).toHaveLength(0);
  });

  it('allows inner generator to stop early based on errors', async () => {
    const [candidateA, candidateB, candidateC] = [
      makeCandidate('a'),
      makeCandidate('b'),
      makeCandidate('c'),
    ];

    const inner = async function* (): AsyncGenerator<
      MetaCandidate,
      void,
      unknown[]
    > {
      let errors: unknown[] = yield candidateA;
      // stop after first failure
      if (errors.length > 0) {
        return;
      }
      errors = yield candidateB;
      if (errors.length > 0) {
        return;
      }
      yield candidateC;
    };

    const { yielded } = await driveToExhaustion(() => proxyPolicy(inner()), []);
    // Only 'a' yielded — inner stops after receiving the first error
    expect(yielded).toStrictEqual([candidateA]);
  });
});

// ---------------------------------------------------------------------------
// withFilter
// ---------------------------------------------------------------------------

describe('withFilter', () => {
  it('passes only matching candidates to the inner policy', async () => {
    const candidates = [
      makeCandidate('a', 1),
      makeCandidate('b', 2),
      makeCandidate('c', 3),
    ];
    const received = vi.fn();

    const inner: Policy<Meta> = async function* (allCandidates) {
      received(allCandidates.map((item) => item.metadata.id));
      yield* allCandidates;
    };

    const policy = withFilter<Meta>(
      (candidate) => (candidate.metadata.cost ?? 0) >= 2,
    )(inner);
    await driveToExhaustion(policy, candidates);

    expect(received).toHaveBeenCalledWith(['b', 'c']);
  });

  it('passes context to the predicate', async () => {
    const candidates = [makeCandidate('alice'), makeCandidate('bob')];
    const contextUsed: PolicyContext<Meta>[] = [];

    const policy = withFilter<Meta>((_candidate, policyContext) => {
      contextUsed.push(policyContext);
      return true;
    })(async function* (allCandidates) {
      yield* allCandidates;
    });

    await driveToExhaustion(policy, candidates);

    expect(contextUsed.length).toBeGreaterThan(0);
    expect(contextUsed[0]).toStrictEqual(ctx);
  });

  it('yields nothing when no candidates match', async () => {
    const candidates = [makeCandidate('a', 1)];
    const policy = withFilter<Meta>(() => false)(
      async function* (allCandidates) {
        yield* allCandidates;
      },
    );

    const { yielded } = await driveToExhaustion(policy, candidates);
    expect(yielded).toHaveLength(0);
  });

  it('returns the inner policy generator directly (no extra wrapping)', () => {
    // withFilter is a pure input transform — it returns the inner policy's
    // generator, not a new proxy generator.
    const innerGen = {} as AsyncGenerator<MetaCandidate, void, unknown[]>;
    const inner: Policy<Meta> = vi.fn(() => innerGen);
    const policy = withFilter<Meta>(() => true)(inner);

    const result = policy([], ctx);
    expect(result).toBe(innerGen);
  });
});

// ---------------------------------------------------------------------------
// withRanking
// ---------------------------------------------------------------------------

describe('withRanking', () => {
  it('sorts candidates before passing to inner policy', async () => {
    const candidates = [
      makeCandidate('a', 3),
      makeCandidate('b', 1),
      makeCandidate('c', 2),
    ];
    const received = vi.fn();

    const inner: Policy<Meta> = async function* (allCandidates) {
      received(allCandidates.map((item) => item.metadata.id));
      yield* allCandidates;
    };

    const policy = withRanking<Meta>(
      (a, b) => (a.metadata.cost ?? 0) - (b.metadata.cost ?? 0),
    )(inner);
    await driveToExhaustion(policy, candidates);

    expect(received).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('does not mutate the original candidates array', async () => {
    const candidates = [makeCandidate('a', 3), makeCandidate('b', 1)];
    const original = [...candidates];

    const policy = withRanking<Meta>(
      (a, b) => (a.metadata.cost ?? 0) - (b.metadata.cost ?? 0),
    )(async function* (allCandidates) {
      yield* allCandidates;
    });

    await driveToExhaustion(policy, candidates);
    expect(candidates).toStrictEqual(original);
  });

  it('returns the inner policy generator directly (no extra wrapping)', () => {
    const innerGen = {} as AsyncGenerator<MetaCandidate, void, unknown[]>;
    const inner: Policy<Meta> = vi.fn(() => innerGen);
    const policy = withRanking<Meta>(() => 0)(inner);

    const result = policy([], ctx);
    expect(result).toBe(innerGen);
  });
});

// ---------------------------------------------------------------------------
// fallthrough
// ---------------------------------------------------------------------------

describe('fallthrough', () => {
  it('yields all candidates from policyA then policyB', async () => {
    const [a1, a2, b1, b2] = [
      makeCandidate('a1'),
      makeCandidate('a2'),
      makeCandidate('b1'),
      makeCandidate('b2'),
    ];

    const policyA: Policy<Meta> = async function* () {
      yield a1;
      yield a2;
    };
    const policyB: Policy<Meta> = async function* () {
      yield b1;
      yield b2;
    };

    const { yielded } = await driveToExhaustion(
      fallthrough(policyA, policyB),
      [],
    );
    expect(yielded).toStrictEqual([a1, a2, b1, b2]);
  });

  it('stops at policyA winner and does not invoke policyB', async () => {
    const [a1, a2] = [makeCandidate('a1'), makeCandidate('a2')];
    const policyBInvoked = vi.fn();

    const policyA: Policy<Meta> = async function* () {
      yield a1;
      yield a2;
    };
    const policyB: Policy<Meta> = async function* () {
      policyBInvoked();
      yield makeCandidate('b1');
    };

    // Succeed on first candidate
    const winner = await driveWithSuccessOn(
      fallthrough(policyA, policyB),
      [],
      1,
    );
    expect(winner).toBe(a1);
    expect(policyBInvoked).not.toHaveBeenCalled();
  });

  it('falls through to policyB when policyA is exhausted', async () => {
    const [a1, b1] = [makeCandidate('a1'), makeCandidate('b1')];

    const policyA: Policy<Meta> = async function* () {
      yield a1;
    };
    const policyB: Policy<Meta> = async function* () {
      yield b1;
    };

    // policyA has one candidate (a1), fail it, then policyB kicks in
    const winner = await driveWithSuccessOn(
      fallthrough(policyA, policyB),
      [],
      2,
    );
    expect(winner).toBe(b1);
  });

  it('forwards error arrays through yield* to each inner policy', async () => {
    const [a1, b1] = [makeCandidate('a1'), makeCandidate('b1')];
    const errorsReceivedByA: unknown[][] = [];
    const errorsReceivedByB: unknown[][] = [];

    const policyA: Policy<Meta> = async function* () {
      const errors: unknown[] = yield a1;
      errorsReceivedByA.push(errors);
    };
    const policyB: Policy<Meta> = async function* () {
      const errors: unknown[] = yield b1;
      errorsReceivedByB.push(errors);
    };

    await driveToExhaustion(fallthrough(policyA, policyB), []);

    // policyA's first yield received one error (a1 failed)
    expect(errorsReceivedByA[0]).toHaveLength(1);
    // policyB's first yield received two errors (a1 + b1 both failed)
    expect(errorsReceivedByB[0]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Composition: withFilter + withRanking + fallthrough
// ---------------------------------------------------------------------------

describe('composition', () => {
  it('withFilter composed with withRanking applies both transforms', async () => {
    const candidates = [
      makeCandidate('a', 3),
      makeCandidate('b', 1),
      makeCandidate('c', 2),
      makeCandidate('d', 4), // filtered out (cost > 3)
    ];
    const received = vi.fn();

    const base: Policy<Meta> = async function* (allCandidates) {
      received(allCandidates.map((item) => item.metadata.id));
      yield* allCandidates;
    };

    const policy = withFilter<Meta>(
      (candidate) => (candidate.metadata.cost ?? 0) <= 3,
    )(
      withRanking<Meta>(
        (a, b) => (a.metadata.cost ?? 0) - (b.metadata.cost ?? 0),
      )(base),
    );

    await driveToExhaustion(policy, candidates);
    // filtered to a/b/c, sorted by cost ascending
    expect(received).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('proxyPolicy wrapping fallthrough threads errors through both layers', async () => {
    const [a1, b1] = [makeCandidate('a1'), makeCandidate('b1')];
    const inner: Policy<Meta> = fallthrough(
      async function* () {
        yield a1;
      },
      async function* () {
        yield b1;
      },
    );

    // proxyPolicy wrapping the whole fallthrough
    const policy: Policy<Meta> = () => proxyPolicy(inner([], ctx));

    const { yielded } = await driveToExhaustion(policy, []);
    expect(yielded).toStrictEqual([a1, b1]);
  });
});
