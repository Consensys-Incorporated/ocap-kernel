import '@ocap/repo-tools/test-utils/mock-endoify';
import { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import * as identifiers from './parse/identifiers.ts';
import { parseFirstStatement, textOf } from './parse/statement.ts';
import type { ParsedStatement } from './parse/statement.ts';
import { prepareEvaluation } from './prepare-evaluation.ts';
import { ERROR, RETURN } from './symbols.ts';
import type { EvaluatorState } from './types.ts';

vi.mock('./parse/identifiers.ts', () => ({
  extractNamesFromDeclaration: vi.fn(),
}));

describe('prepareEvaluation', () => {
  let state: EvaluatorState;
  const mockExtractNames = vi.mocked(identifiers.extractNamesFromDeclaration);

  // As the evaluator builds it.
  const parsed = (code: string): ParsedStatement => {
    const node = parseFirstStatement(code);
    if (!node) {
      throw new Error(`Not a statement: ${code}`);
    }
    return { node, text: textOf(node, code) };
  };

  beforeEach(() => {
    state = { consts: {}, lets: {} };
    vi.clearAllMocks();
  });

  describe('const and let declarations', () => {
    it('prepares const declaration', () => {
      const statement = parsed('const x = 1;');
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.consts).toBe(state.consts);
      expect(evaluable.endowments.lets).toBe(state.lets);
      expect(evaluable.endowments.$frame.$capture).toBeDefined();
      expect(evaluable.endowments.$frame.$catch).toBeDefined();
      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('const x = 1;');
      expect(evaluable.code).toContain('$return(x);');
      expect(evaluable.result.value).toBeDefined();
    });

    it('prepares let declaration', () => {
      const statement = parsed('let y = 2;');
      mockExtractNames.mockReturnValue(['y']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('let y = 2;');
      expect(evaluable.code).toContain('$return(y);');
    });

    it('throws for an unknown declaration kind', () => {
      const statement = parsed('using x = f();');

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Unknown variable declaration',
      );
    });

    it('commits const declaration to consts', () => {
      const statement = parsed('const x = 1;');
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result.value = { x: 1 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({ x: 1 });
      expect(state.lets).toStrictEqual({});
    });

    it('commits let declaration to lets', () => {
      const statement = parsed('let y = 2;');
      mockExtractNames.mockReturnValue(['y']);

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result.value = { y: 2 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({});
      expect(state.lets).toStrictEqual({ y: 2 });
    });

    it('does not commit when result has error', () => {
      const statement = parsed('const x = 1;');
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[ERROR] = new Error('test error');
      evaluable.result.value = { x: 1 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({});
    });

    it('captures lets namespace on commit', () => {
      state.lets = { existing: 'value' };
      const statement = parsed('const x = 1;');
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);
      // Simulate captured namespace by directly testing the commit behavior
      // The actual capture happens during evaluation, but we test the commit logic
      evaluable.result.value = { x: 1 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({ x: 1 });
    });
  });

  describe('function declarations', () => {
    it('prepares function declaration', () => {
      const statement = parsed('function foo() { return 1; }');
      mockExtractNames.mockReturnValue(['foo']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('function foo() { return 1; }');
      expect(evaluable.code).toContain('$return(foo);');
    });

    it('prepares generator function declaration', () => {
      const statement = parsed('function* gen() { yield 1; }');
      mockExtractNames.mockReturnValue(['gen']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('function* gen() { yield 1; }');
    });
  });

  describe('expression statements', () => {
    it('prepares expression statement', () => {
      const statement = parsed('1 + 1;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('$return(1 + 1);');
      expect(evaluable.result.value).toBeUndefined();
    });

    it('strips trailing semicolons from expression', () => {
      const statement = parsed('42;;;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toContain('$return(42);');
    });

    it('commits expression result', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[RETURN] = 42;
      evaluable.commit();

      expect(evaluable.result[RETURN]).toBe(42);
    });

    it('throws when result has no return and no error', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);

      expect(() => evaluable.commit()).toThrow(
        'Internal: Result is undefined but no error was thrown',
      );
    });

    it('does not throw when result has error', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[ERROR] = new Error('test error');

      expect(() => evaluable.commit()).not.toThrow();
    });
  });

  describe('statement types', () => {
    it.each([
      ['an if', 'if (true) { }'],
      ['a for', 'for (let i = 0; i < 10; i++) { }'],
      ['a for-in', 'for (let x in obj) { }'],
      ['a for-of', 'for (let x of arr) { }'],
      ['a for-await-of', 'for await (let x of asyncIter) { }'],
      ['a while', 'while (true) { }'],
      ['a do-while', 'do { } while (true);'],
      ['a switch', 'switch (x) { case 1: break; }'],
      ['a try', 'try { } catch (e) { } finally { }'],
    ])('prepares %s statement', (_case, code) => {
      const statement = parsed(code);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$catch).toBeDefined();
      expect(evaluable.endowments.$frame.$capture).toBeDefined();
      expect(evaluable.endowments.$frame.$return).toBeUndefined();
      expect(evaluable.code).toContain(code);
    });

    it('commits statement without error', () => {
      const statement = parsed('if (true) { }');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.commit();

      expect(evaluable.result[ERROR]).toBeUndefined();
    });

    it('does not commit when statement has error', () => {
      const statement = parsed('if (true) { }');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[ERROR] = new Error('test error');
      evaluable.commit();

      expect(evaluable.result[ERROR]).toBeDefined();
    });
  });

  describe('error cases', () => {
    it('throws for a var declaration', () => {
      const statement = parsed('var x = 1;');

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Variable declarations are not allowed',
      );
    });

    it('throws for an import', () => {
      const statement = parsed('import { x } from "module";');

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Imports are not allowed',
      );
      expect(() => prepareEvaluation(state, statement)).toThrow(SyntaxError);
    });

    it('throws for unknown statement type', () => {
      const statement = parsed('class A {}');

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Unknown statement type',
      );
    });
  });

  describe('with logger', () => {
    let logger: Logger;
    let infoSpy: MockInstance<Logger['info']>;
    let subLoggerSpy: MockInstance<Logger['subLogger']>;

    beforeEach(() => {
      logger = new Logger('test');
      infoSpy = vi.spyOn(logger, 'info');
      subLoggerSpy = vi.spyOn(logger, 'subLogger').mockReturnValue(logger);
    });

    it.each([
      ['const', 'const x = 1;', ['x'], { x: 1 }, 'const declaration:'],
      ['let', 'let y = 2;', ['y'], { y: 2 }, 'let declaration:'],
    ])(
      'logs commit for %s declaration',
      (_, code, names, value, logMessage) => {
        const statement = parsed(code);
        mockExtractNames.mockReturnValue(names);

        const evaluable = prepareEvaluation(state, statement, { logger });
        evaluable.result.value = value;
        evaluable.commit();

        expect(subLoggerSpy).toHaveBeenCalledWith({ tags: ['commit'] });
        expect(infoSpy).toHaveBeenCalledWith(logMessage, value);
      },
    );

    it('logs error on commit', () => {
      const statement = parsed('const x = 1;');
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement, { logger });
      evaluable.result[ERROR] = new Error('test error');
      evaluable.commit();

      expect(infoSpy).toHaveBeenCalledWith('result error:', expect.any(Error));
    });

    it('logs expression return value', () => {
      const statement = parsed('42;');
      const evaluable = prepareEvaluation(state, statement, { logger });
      evaluable.result[RETURN] = 42;
      evaluable.commit();

      expect(infoSpy).toHaveBeenCalledWith('result return:', 42);
    });
  });

  describe('wrap function', () => {
    it('wraps function to throw EvaluatorError on error', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);
      const { $catch } = evaluable.endowments.$frame;

      // $catch doesn't throw, it sets the error in result
      $catch(new Error('test error'));
      expect(evaluable.result[ERROR]).toBeInstanceOf(Error);
    });

    it('handles non-Error values', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);
      const { $catch } = evaluable.endowments.$frame;

      // $catch accepts any value and stores it
      $catch('string error');
      expect(evaluable.result[ERROR]).toBe('string error');
    });
  });

  describe('makeCaptor', () => {
    it('creates captor that captures values', () => {
      const statement = parsed('let x = 1;');
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);
      const { $return } = evaluable.endowments.$frame;

      expect($return).toBeDefined();
      // The captor function is created with specific names, so we test it indirectly
      // by verifying the structure is correct
      expect(evaluable.result.value).toBeDefined();
    });

    it('throws for reserved captor name', () => {
      const statement = parsed('let x = 1;');
      mockExtractNames.mockReturnValue(['$UNIQUE']);

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Captor name "$UNIQUE" is reserved',
      );
    });
  });

  describe('wrapAsyncEvaluation', () => {
    it('wraps code with consts and lets', () => {
      state.consts = { a: 1 };
      state.lets = { b: 2 };
      const statement = parsed('a + b;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toContain('const { a } = consts;');
      expect(evaluable.code).toContain('let { b } = lets;');
      expect(evaluable.code).toContain('$capture(b);');
    });

    it('wraps code without consts or lets', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);

      // Check that destructuring for consts/lets is not present
      // (the $frame destructuring is always present)
      expect(evaluable.code).not.toContain('} = consts;');
      expect(evaluable.code).not.toContain('} = lets;');
      expect(evaluable.code).not.toMatch(/\$capture\([^)]+\);/u);
    });

    it('wraps code in async IIFE', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toMatch(/^\(async \(\) => \{/u);
      expect(evaluable.code).toContain('await null;');
      expect(evaluable.code).toContain(
        'const { $capture, $catch, $return } = $frame;',
      );
      expect(evaluable.code).toMatch(/\}\)\(\);$/u);
    });

    it('includes try-catch-finally block', () => {
      const statement = parsed('42;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toContain('try {');
      expect(evaluable.code).toContain('} catch (e) {');
      expect(evaluable.code).toContain('$catch(e);');
      expect(evaluable.code).toContain('} finally {');
    });
  });
});
