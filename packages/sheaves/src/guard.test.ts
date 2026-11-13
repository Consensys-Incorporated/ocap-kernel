import { M, matches } from '@endo/patterns';
import {
  getInterfaceMethodGuards,
  getMethodPayload,
} from '@metamask/kernel-utils';
import { describe, it, expect } from 'vitest';

import { collectSheafGuard } from './guard.ts';
import { guardCoversPoint } from './match.ts';
import { makeSection } from './section.ts';
import type { Section } from './types.ts';

describe('collectSheafGuard', () => {
  it('variable arity: add with 1, 2, and 3 args', () => {
    const sections = [
      makeSection(
        'Calc:0',
        M.interface('Calc:0', { add: M.call(M.number()).returns(M.number()) }),
        { add: (a: number) => a },
      ),
      makeSection(
        'Calc:1',
        M.interface('Calc:1', {
          add: M.call(M.number(), M.number()).returns(M.number()),
        }),
        { add: (a: number, b: number) => a + b },
      ),
      makeSection(
        'Calc:2',
        M.interface('Calc:2', {
          add: M.call(M.number(), M.number(), M.number()).returns(M.number()),
        }),
        { add: (a: number, b: number, cc: number) => a + b + cc },
      ),
    ];

    const guard = collectSheafGuard('Calc', sections);
    const methodGuards = getInterfaceMethodGuards(guard);
    const payload = getMethodPayload(methodGuards.add!);

    // 1 required arg (present in all), 2 optional (variable arity)
    expect(payload.argGuards).toHaveLength(1);
    expect(payload.optionalArgGuards).toHaveLength(2);
  });

  it('return guard union', () => {
    const sections = [
      makeSection(
        'S:0',
        M.interface('S:0', { f: M.call(M.eq(0)).returns(M.eq(0)) }),
        { f: (_: number) => 0 },
      ),
      makeSection(
        'S:1',
        M.interface('S:1', { f: M.call(M.eq(1)).returns(M.eq(1)) }),
        { f: (_: number) => 1 },
      ),
    ];

    const guard = collectSheafGuard('S', sections);
    const methodGuards = getInterfaceMethodGuards(guard);
    const { returnGuard } = getMethodPayload(methodGuards.f!);

    // Return guard is union of eq(0) and eq(1)
    expect(matches(0, returnGuard)).toBe(true);
    expect(matches(1, returnGuard)).toBe(true);
  });

  it('section with its own optional args: optional preserved in union', () => {
    const sections = [
      makeSection(
        'Greeter',
        M.interface('Greeter', {
          greet: M.callWhen(M.string())
            .optional(M.string())
            .returns(M.string()),
        }),
        { greet: (name: string, _greeting?: string) => `hello ${name}` },
      ),
    ];

    const guard = collectSheafGuard('Greeter', sections);
    const methodGuards = getInterfaceMethodGuards(guard);
    const payload = getMethodPayload(methodGuards.greet!);

    expect(payload.argGuards).toHaveLength(1);
    expect(payload.optionalArgGuards).toHaveLength(1);
  });

  it('rest arg guard preserved in collected union', () => {
    const sections = [
      makeSection(
        'Logger',
        M.interface('Logger', {
          log: M.call(M.string()).rest(M.string()).returns(M.any()),
        }),
        { log: (..._args: string[]) => undefined },
      ),
    ];

    const guard = collectSheafGuard('Logger', sections);
    const methodGuards = getInterfaceMethodGuards(guard);
    const payload = getMethodPayload(methodGuards.log!);

    expect(payload.argGuards).toHaveLength(1);
    expect(payload.optionalArgGuards ?? []).toHaveLength(0);
    expect(payload.restArgGuard).toBeDefined();
  });

  it('rest arg guards unioned across sections', () => {
    const sections = [
      makeSection(
        'A',
        M.interface('A', {
          log: M.call(M.string()).rest(M.string()).returns(M.any()),
        }),
        { log: (..._args: string[]) => undefined },
      ),
      makeSection(
        'B',
        M.interface('B', {
          log: M.call(M.string()).rest(M.number()).returns(M.any()),
        }),
        { log: (..._args: unknown[]) => undefined },
      ),
    ];

    const guard = collectSheafGuard('AB', sections);
    const methodGuards = getInterfaceMethodGuards(guard);
    const { restArgGuard } = getMethodPayload(methodGuards.log!);

    expect(matches('hello', restArgGuard)).toBe(true);
    expect(matches(42, restArgGuard)).toBe(true);
  });

  it('rest-arg section covers optional positions (no false negative)', () => {
    // Section A requires 1 number; Section B requires 0 args but accepts any
    // number of strings via rest. A call ['hello'] is covered by B — the
    // collected guard must pass it too.
    const sections = [
      makeSection(
        'AB:0',
        M.interface('AB:0', { f: M.call(M.number()).returns(M.any()) }),
        { f: (_: number) => undefined },
      ),
      makeSection(
        'AB:1',
        M.interface('AB:1', { f: M.call().rest(M.string()).returns(M.any()) }),
        { f: (..._args: string[]) => undefined },
      ),
    ];

    const guard = collectSheafGuard('AB', sections);

    expect(guardCoversPoint(guard, 'f', ['hello'])).toBe(true); // covered by B
    expect(guardCoversPoint(guard, 'f', [42])).toBe(true); // covered by A
    expect(guardCoversPoint(guard, 'f', [])).toBe(true); // covered by B (0 required)
  });

  it('skips sections without an interface guard', () => {
    const guardedSection = makeSection(
      'Guarded',
      M.interface('Guarded', { f: M.call(M.string()).returns(M.any()) }),
      { f: (_: string) => undefined },
    );
    const guardlessSection: Section = { f: (_: string) => undefined };

    const guard = collectSheafGuard('Mixed', [
      guardlessSection,
      guardedSection,
    ]);
    const methodGuards = getInterfaceMethodGuards(guard);

    expect('f' in methodGuards).toBe(true);
  });

  it('multi-method guard collection', () => {
    const sections = [
      makeSection(
        'Multi:0',
        M.interface('Multi:0', {
          translate: M.call(M.string(), M.string()).returns(M.string()),
        }),
        {
          translate: (from: string, to: string) => `${from}->${to}`,
        },
      ),
      makeSection(
        'Multi:1',
        M.interface('Multi:1', {
          translate: M.call(M.string(), M.string()).returns(M.string()),
          summarize: M.call(M.string()).returns(M.string()),
        }),
        {
          translate: (from: string, to: string) => `${from}->${to}`,
          summarize: (text: string) => `summary: ${text}`,
        },
      ),
    ];

    const guard = collectSheafGuard('Multi', sections);
    const methodGuards = getInterfaceMethodGuards(guard);
    expect('translate' in methodGuards).toBe(true);
    expect('summarize' in methodGuards).toBe(true);
  });
});
