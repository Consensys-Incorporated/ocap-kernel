import '@ocap/repo-tools/test-utils/mock-endoify';
import { EvaluatorError, SampleGenerationError } from '@metamask/kernel-errors';
import { describe, it, expect } from 'vitest';

import { processEvaluationError, stripStackTrace } from './evaluator-error.ts';
import { ERROR } from './symbols.ts';

describe('stripStackTrace', () => {
  it('strips stack trace from Error', () => {
    const error = new Error('test error');
    error.stack = 'Error: test error\n    at test.js:1:1';
    const stripped = stripStackTrace(error);
    expect(stripped).toBeInstanceOf(Error);
    expect((stripped as Error).message).toBe('test error');
    const strippedError = stripped as Error;
    expect(strippedError.stack).not.toContain('at test.js');
  });

  it('preserves error cause chain', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });
    const stripped = stripStackTrace(outer);
    expect((stripped as Error).message).toBe('outer');
    expect((stripped as Error).cause).toBeInstanceOf(Error);
    expect(((stripped as Error).cause as Error).message).toBe('inner');
  });

  it('returns non-Error values unchanged', () => {
    expect(stripStackTrace('string')).toBe('string');
    expect(stripStackTrace(42)).toBe(42);
    expect(stripStackTrace(null)).toBeNull();
  });
});

describe('processEvaluationError', () => {
  it('does nothing when result has no error', () => {
    const result: { [ERROR]?: unknown } = {};
    expect(() => processEvaluationError(result, 'code')).not.toThrow();
  });

  it('throws EvaluatorError for internal errors', () => {
    const result: { [ERROR]?: unknown } = {
      [ERROR]: new EvaluatorError('test', 'code', new Error('cause')),
    };
    expect(() => processEvaluationError(result, 'code')).toThrow(
      EvaluatorError,
    );
  });

  it('throws SampleGenerationError for SyntaxError', () => {
    const result: { [ERROR]?: unknown } = {
      [ERROR]: new SyntaxError('syntax error'),
    };
    expect(() => processEvaluationError(result, 'bad code')).toThrow(
      SampleGenerationError,
    );
  });

  it('throws SampleGenerationError for ReferenceError', () => {
    const result: { [ERROR]?: unknown } = {
      [ERROR]: new ReferenceError('reference error'),
    };
    expect(() => processEvaluationError(result, 'bad code')).toThrow(
      SampleGenerationError,
    );
  });

  it('throws SampleGenerationError for Error objects with SyntaxError name', () => {
    const error = Object.assign(new Error('error'), { name: 'SyntaxError' });
    const result: { [ERROR]?: unknown } = { [ERROR]: error };
    expect(() => processEvaluationError(result, 'bad code')).toThrow(
      SampleGenerationError,
    );
  });

  it('processes and assigns valid-feedback errors', () => {
    const result: { [ERROR]?: unknown } = {
      [ERROR]: new Error('user error'),
    };
    processEvaluationError(result, 'code');
    expect(result[ERROR]).toBeInstanceOf(Error);
    const processedError = result[ERROR] as Error;
    expect(processedError.message).toBe('user error');
  });

  it('wraps non-Error values as Error for valid-feedback', () => {
    const result: { [ERROR]?: unknown } = { [ERROR]: 'string error' };
    processEvaluationError(result, 'code');
    expect(result[ERROR]).toBeInstanceOf(Error);
    expect((result[ERROR] as Error).message).toBe('string error');
  });

  it('strips stack traces from valid-feedback errors', () => {
    const error = new Error('user error');
    error.stack = 'Error: user error\n    at test.js:1:1';
    const result: { [ERROR]?: unknown } = { [ERROR]: error };
    processEvaluationError(result, 'code');
    const processedError = result[ERROR] as Error;
    expect(processedError.message).toBe('user error');
    expect(processedError.stack).not.toContain('at test.js');
  });
});
