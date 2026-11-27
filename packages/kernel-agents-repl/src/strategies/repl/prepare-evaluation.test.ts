import '@ocap/repo-tools/test-utils/mock-endoify';
import { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import * as identifiers from './parse/identifiers.ts';
import type { SyntaxTree } from './parse/syntax-tree.ts';
import { prepareEvaluation } from './prepare-evaluation.ts';
import { ERROR, RETURN } from './symbols.ts';
import type { EvaluatorState } from './types.ts';

vi.mock('./parse/identifiers.ts', () => ({
  extractNamesFromDeclaration: vi.fn(),
}));

describe('prepareEvaluation', () => {
  let state: EvaluatorState;
  const mockExtractNames = vi.mocked(identifiers.extractNamesFromDeclaration);

  const createMockNode = (
    type: string,
    text: string,
    children: SyntaxTree[] = [],
  ): SyntaxTree => ({ type, text, isNamed: true, children });

  beforeEach(() => {
    state = { consts: {}, lets: {} };
    vi.clearAllMocks();
  });

  describe('lexical_declaration', () => {
    it('prepares const declaration', () => {
      const statement = createMockNode('lexical_declaration', 'const x = 1;', [
        createMockNode('const', 'const'),
      ]);
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.consts).toStrictEqual(state.consts);
      expect(evaluable.endowments.consts).not.toBe(state.consts);
      expect(evaluable.endowments.lets).toStrictEqual(state.lets);
      expect(evaluable.endowments.lets).not.toBe(state.lets);
      expect(evaluable.endowments.$frame.$capture).toBeDefined();
      expect(evaluable.endowments.$frame.$catch).toBeDefined();
      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('const x = 1;');
      expect(evaluable.code).toContain('$return(x);');
      expect(evaluable.result.value).toBeDefined();
    });

    it('prepares let declaration', () => {
      const statement = createMockNode('lexical_declaration', 'let y = 2;', [
        createMockNode('let', 'let'),
      ]);
      mockExtractNames.mockReturnValue(['y']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('let y = 2;');
      expect(evaluable.code).toContain('$return(y);');
    });

    it('throws for unknown lexical_declaration', () => {
      const statement = createMockNode(
        'lexical_declaration',
        'unknown x = 1;',
        [createMockNode('unknown', 'unknown')],
      );

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Unknown lexical_declaration',
      );
    });

    it('commits const declaration to consts', () => {
      const statement = createMockNode('lexical_declaration', 'const x = 1;', [
        createMockNode('const', 'const'),
      ]);
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result.value = { x: 1 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({ x: 1 });
      expect(state.lets).toStrictEqual({});
    });

    it('commits let declaration to lets', () => {
      const statement = createMockNode('lexical_declaration', 'let y = 2;', [
        createMockNode('let', 'let'),
      ]);
      mockExtractNames.mockReturnValue(['y']);

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result.value = { y: 2 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({});
      expect(state.lets).toStrictEqual({ y: 2 });
    });

    it('does not commit when result has error', () => {
      const statement = createMockNode('lexical_declaration', 'const x = 1;', [
        createMockNode('const', 'const'),
      ]);
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[ERROR] = new Error('test error');
      evaluable.result.value = { x: 1 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({});
    });

    it('captures lets namespace on commit', () => {
      state.lets = { existing: 'value' };
      const statement = createMockNode('lexical_declaration', 'const x = 1;', [
        createMockNode('const', 'const'),
      ]);
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement);
      // Simulate captured namespace by directly testing the commit behavior
      // The actual capture happens during evaluation, but we test the commit logic
      evaluable.result.value = { x: 1 };
      evaluable.commit();

      expect(state.consts).toStrictEqual({ x: 1 });
    });
  });

  describe('function_declaration', () => {
    it('prepares function declaration', () => {
      const statement = createMockNode(
        'function_declaration',
        'function foo() { return 1; }',
      );
      mockExtractNames.mockReturnValue(['foo']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('function foo() { return 1; }');
      expect(evaluable.code).toContain('$return(foo);');
    });

    it('prepares generator function declaration', () => {
      const statement = createMockNode(
        'generator_function_declaration',
        'function* gen() { yield 1; }',
      );
      mockExtractNames.mockReturnValue(['gen']);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('function* gen() { yield 1; }');
    });
  });

  describe('expression_statement', () => {
    it('prepares expression statement', () => {
      const statement = createMockNode('expression_statement', '1 + 1;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$return).toBeDefined();
      expect(evaluable.code).toContain('$return(1 + 1);');
      expect(evaluable.result.value).toBeUndefined();
    });

    it('strips trailing semicolons from expression', () => {
      const statement = createMockNode('expression_statement', '42;;;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toContain('$return(42);');
    });

    it('commits expression result', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[RETURN] = 42;
      evaluable.commit();

      expect(evaluable.result[RETURN]).toBe(42);
    });

    it('throws when result has no return and no error', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);

      expect(() => evaluable.commit()).toThrow(
        'Internal: Result is undefined but no error was thrown',
      );
    });

    it('does not throw when result has error', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[ERROR] = new Error('test error');

      expect(() => evaluable.commit()).not.toThrow();
    });
  });

  describe('statement types', () => {
    it.each([
      ['if_statement', 'if (true) { }'],
      ['for_statement', 'for (let i = 0; i < 10; i++) { }'],
      ['for_in_statement', 'for (let x in obj) { }'],
      ['for_of_statement', 'for (let x of arr) { }'],
      ['for_await_of_statement', 'for await (let x of asyncIter) { }'],
      ['for_await_in_statement', 'for await (let x in asyncIter) { }'],
      ['for_await_statement', 'for await (let x of asyncIter) { }'],
      ['while_statement', 'while (true) { }'],
      ['do_while_statement', 'do { } while (true);'],
      ['switch_statement', 'switch (x) { case 1: break; }'],
      ['try_statement', 'try { } catch (e) { }'],
      ['catch_clause', 'catch (e) { }'],
      ['finally_clause', 'finally { }'],
    ])('prepares %s', (type, code) => {
      const statement = createMockNode(type, code);

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.endowments.$frame.$catch).toBeDefined();
      expect(evaluable.endowments.$frame.$capture).toBeDefined();
      expect(evaluable.endowments.$frame.$return).toBeUndefined();
      expect(evaluable.code).toContain(code);
    });

    it('commits statement without error', () => {
      const statement = createMockNode('if_statement', 'if (true) { }');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.commit();

      expect(evaluable.result[ERROR]).toBeUndefined();
    });

    it('does not commit when statement has error', () => {
      const statement = createMockNode('if_statement', 'if (true) { }');

      const evaluable = prepareEvaluation(state, statement);
      evaluable.result[ERROR] = new Error('test error');
      evaluable.commit();

      expect(evaluable.result[ERROR]).toBeDefined();
    });
  });

  describe('error cases', () => {
    it('throws for variable_declaration', () => {
      const statement = createMockNode('variable_declaration', 'var x = 1;');

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Variable declarations are not allowed',
      );
    });

    it('throws for import_statement', () => {
      const statement = createMockNode(
        'import_statement',
        'import { x } from "module";',
      );

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Imports are not allowed',
      );
      expect(() => prepareEvaluation(state, statement)).toThrow(SyntaxError);
    });

    it('throws for unknown statement type', () => {
      const statement = createMockNode('unknown_type', 'unknown code');

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
        const statement = createMockNode('lexical_declaration', code, [
          createMockNode(
            code.split(' ')[0] as string,
            code.split(' ')[0] as string,
          ),
        ]);
        mockExtractNames.mockReturnValue(names);

        const evaluable = prepareEvaluation(state, statement, { logger });
        evaluable.result.value = value;
        evaluable.commit();

        expect(subLoggerSpy).toHaveBeenCalledWith({ tags: ['commit'] });
        expect(infoSpy).toHaveBeenCalledWith(logMessage, value);
      },
    );

    it('logs error on commit', () => {
      const statement = createMockNode('lexical_declaration', 'const x = 1;', [
        createMockNode('const', 'const'),
      ]);
      mockExtractNames.mockReturnValue(['x']);

      const evaluable = prepareEvaluation(state, statement, { logger });
      evaluable.result[ERROR] = new Error('test error');
      evaluable.commit();

      expect(infoSpy).toHaveBeenCalledWith('result error:', expect.any(Error));
    });

    it('logs expression return value', () => {
      const statement = createMockNode('expression_statement', '42;');
      const evaluable = prepareEvaluation(state, statement, { logger });
      evaluable.result[RETURN] = 42;
      evaluable.commit();

      expect(infoSpy).toHaveBeenCalledWith('result return:', 42);
    });
  });

  describe('wrap function', () => {
    it('wraps function to throw EvaluatorError on error', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);
      const { $catch } = evaluable.endowments.$frame;

      // $catch doesn't throw, it sets the error in result
      $catch(new Error('test error'));
      expect(evaluable.result[ERROR]).toBeInstanceOf(Error);
    });

    it('handles non-Error values', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);
      const { $catch } = evaluable.endowments.$frame;

      // $catch accepts any value and stores it
      $catch('string error');
      expect(evaluable.result[ERROR]).toBe('string error');
    });
  });

  describe('makeCaptor', () => {
    it.each([
      ['every name', [1, 2], { x: 1, y: 2 }],
      ['a missing value as undefined', [1], { x: 1, y: undefined }],
    ])('returns %s', (_case, values, expected) => {
      const statement = createMockNode('lexical_declaration', 'let x, y;', [
        createMockNode('let', 'let'),
      ]);
      mockExtractNames.mockReturnValue(['x', 'y']);

      const evaluable = prepareEvaluation(state, statement);
      const $return = evaluable.endowments.$frame.$return as (
        ...args: unknown[]
      ) => void;
      $return(...values);

      expect(evaluable.result.value).toStrictEqual(expected);
    });

    it('captures the lets into the state on commit', () => {
      state.lets = { x: 1, y: 2 };
      const statement = createMockNode('expression_statement', '1;');

      const evaluable = prepareEvaluation(state, statement);
      const $capture = evaluable.endowments.$frame.$capture as (
        ...args: unknown[]
      ) => void;
      $capture(3, 4);
      evaluable.result[RETURN] = 1;
      evaluable.commit();

      expect(state.lets).toStrictEqual({ x: 3, y: 4 });
    });

    it.each([
      '$frame',
      '$capture',
      '$catch',
      '$return',
      'consts',
      'lets',
      '__proto__',
      'a)=>0,(globalThis.x = 1),()=>{}//',
      'a b',
    ])('throws for the declared name %s', (name) => {
      const statement = createMockNode('lexical_declaration', 'let x = 1;', [
        createMockNode('let', 'let'),
      ]);
      mockExtractNames.mockReturnValue([name]);

      expect(() => prepareEvaluation(state, statement)).toThrow(
        `Cannot capture the name "${name}"`,
      );
    });

    it('throws for a let name that is not an identifier', () => {
      state.lets['a)=>0'] = 1;
      const statement = createMockNode('expression_statement', '1;');

      expect(() => prepareEvaluation(state, statement)).toThrow(
        'Cannot capture the name "a)=>0"',
      );
    });

    it.each(['café', '$x', '_y', 'z9'])(
      'captures the identifier %s',
      (name) => {
        const statement = createMockNode('lexical_declaration', 'let x = 1;', [
          createMockNode('let', 'let'),
        ]);
        mockExtractNames.mockReturnValue([name]);

        expect(prepareEvaluation(state, statement).code).toContain(
          `$return(${name});`,
        );
      },
    );
  });

  describe('wrapAsyncEvaluation', () => {
    it('wraps code with consts and lets', () => {
      state.consts = { a: 1 };
      state.lets = { b: 2 };
      const statement = createMockNode('expression_statement', 'a + b;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toContain('const { a } = consts;');
      expect(evaluable.code).toContain('let { b } = lets;');
      expect(evaluable.code).toContain('$capture(b);');
    });

    it('wraps code without consts or lets', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);

      // Check that destructuring for consts/lets is not present
      // (the $frame destructuring is always present)
      expect(evaluable.code).not.toContain('} = consts;');
      expect(evaluable.code).not.toContain('} = lets;');
      expect(evaluable.code).not.toMatch(/\$capture\([^)]+\);/u);
    });

    it('wraps code in async IIFE', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toMatch(/^\(async \(\) => \{/u);
      expect(evaluable.code).toContain('await null;');
      expect(evaluable.code).toContain(
        'const { $capture, $catch, $return } = $frame;',
      );
      expect(evaluable.code).toMatch(/\}\)\(\);$/u);
    });

    it('includes try-catch-finally block', () => {
      const statement = createMockNode('expression_statement', '42;');

      const evaluable = prepareEvaluation(state, statement);

      expect(evaluable.code).toContain('try {');
      expect(evaluable.code).toContain('} catch (e) {');
      expect(evaluable.code).toContain('$catch(e);');
      expect(evaluable.code).toContain('} finally {');
    });
  });
});
