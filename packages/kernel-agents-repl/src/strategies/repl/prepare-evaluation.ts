import { EvaluatorError } from '@metamask/kernel-errors';
import type { Logger } from '@metamask/logger';
import type { SyntaxNode } from 'tree-sitter';

import { extractNamesFromDeclaration } from './parse/identifiers.ts';
import { ERROR, RETURN } from './symbols.ts';
import type { EvaluatorState, VariableRecord } from './types.ts';

/**
 * Creates a wrapper for a function that throws EvaluatorError if the wrapped function throws.
 * This is used to wrap $return, $catch, and $capture to differentiate between internal and user errors.
 *
 * @param func - The function to wrap.
 * @returns A hardened function that wraps the original function.
 */
const wrap = <Args extends unknown[]>(
  func: (...args: Args) => void,
): ((...args: Args) => void) => {
  return harden((...args: Args) => {
    try {
      func(...args);
    } catch (error) {
      throw new EvaluatorError(
        'REPL evaluation failed',
        '',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
};

export type Evaluable = {
  endowments: {
    consts: VariableRecord;
    lets: VariableRecord;
    $frame: {
      $catch: (caught: unknown) => void;
      $capture: (...lets: never[]) => void;
      $return?: (...values: never[]) => void;
    };
  };
  code: string;
  result: EvaluationResult;
  commit: () => void;
};

export type EvaluationResult = {
  value?: VariableRecord;
  [ERROR]?: unknown;
  [RETURN]?: unknown;
};

/**
 * Wraps an async evaluation in an IIFE to be awaited outside the compartment.
 * Assumes a compartment endowed with `{ consts, lets, $catch, $capture }` at
 * least.
 *
 * TODO: Move this functionality to endojs/endo-evaluator
 *
 * @param args - The arguments to wrap the async evaluation.
 * @param args.consts - The consts to destructure.
 * @param args.lets - The lets to destructure.
 * @param args.code - The code to evaluate.
 * @returns Wrapped code ready to evaluate in a compartment endowed with `{ consts, lets, $catch, $capture }`.
 */
const wrapAsyncEvaluation = ({
  consts,
  lets,
  code,
}: {
  consts: VariableRecord;
  lets: VariableRecord;
  code: string;
}): string => {
  const constsKeys = Object.keys(consts);
  const letsKeys = Object.keys(lets);
  const destructureConsts =
    constsKeys.length > 0 ? `const { ${constsKeys.join(',')} } = consts;` : '';
  const destructureLets =
    letsKeys.length > 0 ? `let { ${letsKeys.join(',')} } = lets;` : '';
  // The let namespace can be arbitrarily mutated by the statement; the best
  // detection is captureion.
  const captureLets =
    letsKeys.length > 0 ? `$capture(${letsKeys.join(',')});` : '';
  // Async IIFE, to be awaited outside the compartment. We are 'vulnerable' to
  // return statements, but we only await whatever is returned; we don't read
  // the value. We can also prevent top level return via parsing.
  return `(async () => {
    await null;
    const { $capture, $catch, $return } = $frame;
    ${destructureConsts}
    ${destructureLets}
    try {
      ${code}
    } catch (e) {
      $catch(e);
    } finally {
      ${captureLets}
    }
  })();`;
};

/**
 * Make a captor function that captures names from lexical scope into a record.
 *
 * Building a function factory from source permits captureion of the
 * arguments as individual variables while the record to which they are
 * assigned is a reference not endowed to the compartment.
 *
 * The returned function is wrapped with makeSafe to detect internal errors.
 *
 * @param names - The names to capture.
 * @returns A tuple containing the record and a safe-wrapped function that captures the names into the record.
 */
const makeCaptor = (
  names: string[],
): [VariableRecord, (...names: string[]) => void] => {
  const $value = '$UNIQUE';
  if (names.includes($value)) {
    throw new Error(`Captor name "${$value}" is reserved`);
  }
  const value: VariableRecord = {};
  const namespace = names.join(',');
  // We use eval safely by constructing the function with care and only
  // ever evaluating it in a compartment.
  // oxlint-disable-next-line typescript/no-implied-eval, no-new-func
  const captor = Function(
    $value,
    `return (${namespace}) => void Object.assign(${$value}, { ${namespace} });`,
  )(value);
  return [value, wrap(captor)];
};

export const prepareEvaluation = (
  state: EvaluatorState,
  statement: SyntaxNode,
  options: { logger?: Logger } = {},
): Evaluable => {
  switch (statement.type) {
    case 'lexical_declaration':
      switch (statement.children[0]?.type) {
        case 'const':
          return prepareImmutableDeclaration(state, statement, options);
        case 'let':
          return prepareMutableDeclaration(state, statement, options);
        case undefined:
        default:
          throw new Error(
            [
              `Unknown lexical_declaration.`,
              `statement: ${statement.text}`,
              `type: ${statement.toString()}`,
            ].join('\n'),
          );
      }
    case 'function_declaration':
    case 'generator_function_declaration':
      return prepareMutableDeclaration(state, statement, options);
    case 'variable_declaration':
      throw new Error(
        `Variable declarations are not allowed: "${statement.text}"`,
      );
    case 'expression_statement':
      return prepareExpression(state, statement, options);
    case 'import_statement':
      throw new SyntaxError(
        'Imports are not allowed. All accessible capabilities are already imported.',
      );
    case 'if_statement':
    case 'for_statement':
    case 'for_in_statement':
    case 'for_of_statement':
    case 'for_await_of_statement':
    case 'for_await_in_statement':
    case 'for_await_statement':
    case 'while_statement':
    case 'do_while_statement':
    case 'switch_statement':
    case 'try_statement':
    case 'catch_clause':
    case 'finally_clause':
      // XXX The above case selector is probably long enough to be the default
      return prepareStatement(state, statement, options);
    default:
      throw new Error(
        [
          `Unknown statement type.`,
          `statement: ${statement.text}`,
          `type: ${statement.toString()}`,
        ].join('\n'),
      );
  }
};

/**
 * Prepare a declaration for evaluation.
 *
 * @param state - The evaluator state.
 * @param statement - The declaration to prepare.
 * @returns The prepared declaration.
 */
function prepareDeclaration(
  state: EvaluatorState,
  statement: SyntaxNode,
): Omit<Evaluable, 'commit'> & { captured: VariableRecord } {
  const { consts, lets } = state;
  const [captured, $capture] = makeCaptor(Object.keys(lets));
  const names = extractNamesFromDeclaration(statement);
  const [value, $return] = makeCaptor(names);
  const result: EvaluationResult = { value };
  const $catch = wrap((caught: unknown) => (result[ERROR] = caught));
  return {
    endowments: { consts, lets, $frame: { $capture, $catch, $return } },
    code: wrapAsyncEvaluation({
      consts,
      lets,
      code: `${statement.text};$return(${names.join(',')});`,
    }),
    result,
    captured,
  };
}

/**
 * Prepare a mutable declaration (let or function declaration) for evaluation.
 *
 * @param state - The evaluator state.
 * @param statement - The declaration to prepare.
 * @param options - The options.
 * @param options.logger - The logger.
 * @returns The prepared declaration.
 */
function prepareMutableDeclaration(
  state: EvaluatorState,
  statement: SyntaxNode,
  options: { logger?: Logger } = {},
): Evaluable {
  const { endowments, code, result, captured } = prepareDeclaration(
    state,
    statement,
  );
  const commitLogger = options.logger?.subLogger({ tags: ['commit'] });
  return {
    endowments,
    code,
    result,
    commit: () => {
      commitLogger?.info('captured namespace:', captured);
      Object.assign(state.lets, captured);
      if (result[ERROR]) {
        commitLogger?.info('result error:', result[ERROR]);
        return;
      }
      commitLogger?.info('let declaration:', result.value);
      Object.assign(state.lets, result.value);
    },
  };
}

/**
 * Prepare an immutable declaration (const declaration) for evaluation.
 *
 * @param state - The evaluator state.
 * @param statement - The declaration to prepare.
 * @param options - The options.
 * @param options.logger - The logger.
 * @returns The prepared declaration.
 */
function prepareImmutableDeclaration(
  state: EvaluatorState,
  statement: SyntaxNode,
  options: { logger?: Logger } = {},
): Evaluable {
  const { endowments, code, result, captured } = prepareDeclaration(
    state,
    statement,
  );
  const commitLogger = options.logger?.subLogger({ tags: ['commit'] });
  return {
    endowments,
    code,
    result,
    commit: () => {
      commitLogger?.info('captured namespace:', captured);
      Object.assign(state.lets, captured);
      if (result[ERROR]) {
        commitLogger?.info('result error:', result[ERROR]);
        return;
      }
      commitLogger?.info('const declaration:', result.value);
      Object.assign(state.consts, result.value);
    },
  };
}

/**
 * Strips any trailing semicolons from the code.
 *
 * @param code - The code to strip the trailing semicolons from.
 * @returns The code without the trailing semicolons.
 */
const stripTrailingSemicolons = (code: string): string =>
  code.trimEnd().endsWith(';')
    ? stripTrailingSemicolons(code.trimEnd().slice(0, -1))
    : code.trimEnd();

/**
 * Prepare an expression for evaluation.
 *
 * @param state - The evaluator state.
 * @param statement - The expression to prepare.
 * @param options - The options.
 * @param options.logger - The logger.
 * @returns The prepared expression.
 */
function prepareExpression(
  state: EvaluatorState,
  statement: SyntaxNode,
  options: { logger?: Logger } = {},
): Evaluable {
  const { consts, lets } = state;
  const [captured, $capture] = makeCaptor(Object.keys(lets));
  const result: EvaluationResult = {};
  const $return = wrap((value: unknown) => (result[RETURN] = value));
  const $catch = wrap((caught: unknown) => (result[ERROR] = caught));
  const commitLogger = options.logger?.subLogger({ tags: ['commit'] });
  return {
    endowments: { consts, lets, $frame: { $capture, $catch, $return } },
    code: wrapAsyncEvaluation({
      consts,
      lets,
      code: `$return(${stripTrailingSemicolons(statement.text)});`,
    }),
    result,
    commit: () => {
      commitLogger?.info('captured namespace:', captured);
      Object.assign(state.lets, captured);
      if (result[ERROR]) {
        commitLogger?.info('result error:', result[ERROR]);
        return;
      }
      commitLogger?.info('result return:', result[RETURN]);
      if (!(RETURN in result)) {
        throw new Error(
          'Internal: Result is undefined but no error was thrown',
        );
      }
    },
  };
}

/**
 * Prepare an arbitrary statement for evaluation.
 *
 * @param state - The evaluator state.
 * @param statement - The statement to prepare.
 * @param options - The options.
 * @param options.logger - The logger.
 * @returns The prepared statement.
 */
function prepareStatement(
  state: EvaluatorState,
  statement: SyntaxNode,
  options: { logger?: Logger } = {},
): Evaluable {
  const { consts, lets } = state;
  const [captured, $capture] = makeCaptor(Object.keys(lets));
  const result: EvaluationResult = {};
  const $catch = wrap((caught: unknown) => (result[ERROR] = caught));
  const commitLogger = options.logger?.subLogger({ tags: ['commit'] });
  return {
    endowments: { consts, lets, $frame: { $capture, $catch } },
    code: wrapAsyncEvaluation({
      consts,
      lets,
      code: statement.text,
    }),
    result,
    commit: () => {
      commitLogger?.info('captured namespace:', captured);
      Object.assign(state.lets, captured);
      if (result[ERROR]) {
        commitLogger?.info('result error:', result[ERROR]);
      }
    },
  };
}
