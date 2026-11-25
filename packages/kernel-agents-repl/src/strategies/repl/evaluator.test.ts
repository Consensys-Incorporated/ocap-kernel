import 'ses'; // We need the real Compartment, not the mock.
import '@ocap/repo-tools/test-utils/mock-endoify';
import { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeEvaluator } from './evaluator.ts';
import {
  CommentMessage,
  EvaluationMessage,
  ImportMessage,
  ResultMessage,
  StatementMessage,
} from './messages.ts';
import type { ReplTranscript } from './messages.ts';
import { makeTreeSitterParser } from './parse/tree-sitter.ts';
import type { EvaluatorState } from './types.ts';

const parser = makeTreeSitterParser();
const fromCode = async (code: string): Promise<StatementMessage> =>
  StatementMessage.fromCode(code, parser);

describe('evaluator', () => {
  let state: EvaluatorState;
  let evaluator: ReturnType<typeof makeEvaluator>;
  const logger = new Logger('test');

  beforeEach(() => {
    state = { consts: {}, lets: {} };
    evaluator = makeEvaluator({ initState: () => state, logger });
  });

  const evaluateStatements = async (...statements: string[]) => {
    const history: ReplTranscript = [];
    for (const statement of statements) {
      await evaluator(history, await fromCode(statement));
    }
  };

  describe('evaluates statements', () => {
    it('evaluates expressions', async () => {
      const history: ReplTranscript = [];
      const result = await evaluator(history, await fromCode('42;'));
      expect(result).toBeInstanceOf(ResultMessage);
      expect(result?.messageBody.return).toBe('42');
    });

    it('evaluates declarations and updates state', async () => {
      await evaluateStatements(
        'const x = 1;',
        'let y = x + 2;',
        'function foo() { return "bar"; }',
        'const z = foo();',
      );
      expect(state).toStrictEqual({
        consts: { x: 1, z: 'bar' },
        lets: { y: 3, foo: expect.any(Function) },
      });
    });

    it('evaluates loops', async () => {
      await evaluateStatements(
        'let x = 1;',
        'for (let i = 1; i <= 4; i++) { x *= i; }',
      );
      expect(state.lets).toStrictEqual({ x: 24 });
    });

    it('captures mutated let variables', async () => {
      await evaluateStatements('let x = 1;', 'x = 2;', 'x = 3;');
      expect(state.lets).toStrictEqual({ x: 3 });
    });
  });

  describe('handles statement types', () => {
    it('handles comment messages', async () => {
      const history: ReplTranscript = [];
      const comment = new CommentMessage('// comment');
      const result = await evaluator(history, comment);
      expect(result).toBeNull();
      expect(history).toHaveLength(1);
      expect(history[0]).toBe(comment);
    });

    it('handles import messages', async () => {
      const history: ReplTranscript = [];
      const importMsg = new ImportMessage('import { x } from "y";');
      const result = await evaluator(history, importMsg);
      expect(result).toBeInstanceOf(ResultMessage);
      expect(history).toHaveLength(2);
      expect(history[0]).toBe(importMsg);
    });

    it('rejects variable declarations', async () => {
      const statement = await fromCode('var x = 1;');
      await expect(evaluator([], statement)).rejects.toThrow(
        'Variable declarations are not allowed',
      );
    });

    it('rejects an evaluation that was never parsed', async () => {
      const statement = new EvaluationMessage('1 + 1;');
      await expect(evaluator([], statement)).rejects.toThrow(
        'Internal: Unknown statement\nstatement: 1 + 1;\ntype: unparsed',
      );
    });
  });

  describe('creates result messages', () => {
    it('creates result with return value', async () => {
      const history: ReplTranscript = [];
      const result = await evaluator(history, await fromCode('"hello";'));
      expect(result).toBeInstanceOf(ResultMessage);
      expect(result?.messageBody.return).toBe('"hello"');
    });

    it('creates result with declaration value', async () => {
      const history: ReplTranscript = [];
      const result = await evaluator(history, await fromCode('const x = 42;'));
      expect(result).toBeInstanceOf(ResultMessage);
      expect(result?.messageBody.value).toBe('x: 42');
    });

    it('returns null when no result keys are present', async () => {
      const history: ReplTranscript = [];
      const result = await evaluator(
        history,
        await fromCode('for (let i = 0; i < 1; i++) {}'),
      );
      expect(result).toBeNull();
    });
  });

  describe('manages state', () => {
    it('does not update state when evaluation has error', async () => {
      const initialState = { consts: {}, lets: {} };
      const history: ReplTranscript = [];
      await evaluator(history, await fromCode('const x = undefined.y;'));
      expect(state).toStrictEqual(initialState);
    });
  });

  describe('integrates capabilities', () => {
    it('evaluates capability calls', async () => {
      const mockCap = vi.fn().mockReturnValue('result');
      const evaluatorWithCap = makeEvaluator({
        initState: () => state,
        capabilities: {
          testCap: {
            func: mockCap,
            schema: { description: 'Test capability', args: {} },
          },
        },
      });
      const history: ReplTranscript = [];
      await evaluatorWithCap(history, await fromCode('testCap();'));
      expect(mockCap).toHaveBeenCalled();
    });

    it('handles multiple capabilities', async () => {
      const cap1 = vi.fn().mockReturnValue(1);
      const cap2 = vi.fn().mockReturnValue(2);
      const evaluatorWithCaps = makeEvaluator({
        initState: () => state,
        capabilities: {
          cap1: {
            func: cap1,
            schema: { description: 'Capability 1', args: {} },
          },
          cap2: {
            func: cap2,
            schema: { description: 'Capability 2', args: {} },
          },
        },
      });
      const history: ReplTranscript = [];
      await evaluatorWithCaps(history, await fromCode('cap1() + cap2();'));
      expect(cap1).toHaveBeenCalled();
      expect(cap2).toHaveBeenCalled();
    });
  });
});
