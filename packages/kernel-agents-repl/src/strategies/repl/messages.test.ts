import 'ses';
import '@ocap/repo-tools/test-utils/mock-endoify';
import { describe, it, expect } from 'vitest';

import {
  CommentMessage,
  EvaluationMessage,
  ImportMessage,
  InterjectionMessage,
  MAX_LINES,
  ResultMessage,
  StatementMessage,
  observeJson,
} from './messages.ts';
import type { SyntaxTree } from './parse/syntax-tree.ts';
import { makeTreeSitterParser } from './parse/tree-sitter.ts';
import { ERROR, RETURN } from './symbols.ts';

describe('observeJson', () => {
  it.each([
    ['hello', '"hello"'],
    [42, '42'],
    [true, 'true'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('stringifies primitive %s', (value, expected) => {
    expect(observeJson(value)).toBe(expected);
  });

  it('uses toJsonString for JsonObservable', () => {
    expect(observeJson({ toJsonString: () => '"custom"' })).toBe('"custom"');
  });

  it('stringifies arrays and objects', () => {
    expect(observeJson([1, 2, 3])).toBe('[\n  1,\n  2,\n  3\n]');
    expect(observeJson({ a: 1, b: 2 })).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });
});

describe('StatementMessage', () => {
  const parser = makeTreeSitterParser();

  it.each([
    ['// comment', CommentMessage, 'comment', 'comment'],
    ['import { foo } from "bar";', ImportMessage, 'import', 'import_statement'],
    ['1 + 1;', EvaluationMessage, 'evaluation', 'expression_statement'],
  ])('creates %s from code', async (code, Class, type, nodeType) => {
    const message = await StatementMessage.fromCode(code, parser);
    expect(message).toBeInstanceOf(Class);
    expect(message.messageType).toBe(type);
    expect(message.messageBody.code).toBe(code);
    expect(message.messageBody.node?.type).toBe(nodeType);
    expect(message.toReplString()).toBe(`> ${code}`);
  });
});

describe.each([
  ['CommentMessage', CommentMessage, '// comment', 'comment'],
  ['ImportMessage', ImportMessage, 'import { foo } from "bar";', 'import'],
  ['EvaluationMessage', EvaluationMessage, '1 + 1;', 'evaluation'],
])('%s', (_, Class, code, type) => {
  it('creates message with node', () => {
    const node = { type } as SyntaxTree;
    const message = new Class(code, node);
    expect(message.messageType).toBe(type);
    expect(message.messageBody).toStrictEqual({ code, node });
    expect(message.toReplString()).toBe(`> ${code}`);
  });

  it('creates message without node', () => {
    const message = new Class(code);
    expect(message.messageType).toBe(type);
    expect(message.messageBody).toStrictEqual({ code });
  });
});

describe('ImportMessage', () => {
  it.each([
    [['foo', 'bar'], 'import { foo, bar } from "@ocap/abilities";'],
    [['foo'], 'import { foo } from "@ocap/abilities";'],
    [[], 'import {  } from "@ocap/abilities";'],
  ])('creates from names %s', (names, expected) => {
    const message = ImportMessage.fromNames(names);
    expect(message.messageType).toBe('import');
    expect(message.messageBody.code).toBe(expected);
  });
});

describe('InterjectionMessage', () => {
  it('creates message and serializes', () => {
    const message = new InterjectionMessage('test');
    expect(message.messageType).toBe('interjection');
    expect(message.messageBody.interjection).toBe('test');
    expect(message.toReplString()).toBe('! test');
    expect(message.toJsonString()).toBe('{ "messageType": "interjection",  }');
  });
});

describe('ResultMessage', () => {
  const longValue = Array.from({ length: 2 * MAX_LINES }, (_, i) => ({
    [`key${i}`]: `value${i}`,
  }));
  const longString = Array.from(
    { length: 2 * MAX_LINES },
    (_, i) => `line ${i}`,
  ).join('\n');

  it('creates message with return value', () => {
    const message = new ResultMessage({ [RETURN]: 'hello' });
    expect(message.messageType).toBe('result');
    expect(message.messageBody.return).toBeDefined();
    expect(message.messageBody.error).toBeUndefined();
    expect(message.messageBody.value).toBeUndefined();
  });

  it('creates message with error', () => {
    const message = new ResultMessage({ [ERROR]: new Error('test') });
    expect(message.messageType).toBe('result');
    expect(message.messageBody.error).toBeDefined();
    expect(message.messageBody.return).toBeUndefined();
    expect(message.messageBody.value).toBeUndefined();
  });

  it('creates message with value', () => {
    const message = new ResultMessage({ value: { x: 1 } });
    expect(message.messageType).toBe('result');
    expect(message.messageBody.value).toBeDefined();
    expect(message.messageBody.return).toBeUndefined();
    expect(message.messageBody.error).toBeUndefined();
  });

  it('formats error correctly', () => {
    const message = new ResultMessage({ [ERROR]: new Error('test') });
    expect(message.messageBody.error).toBe('Error: test');
  });

  it('creates message with all result types', () => {
    const message = new ResultMessage({
      [ERROR]: new Error('test'),
      [RETURN]: 'returned',
      value: { x: 1 },
    });
    expect(message.messageType).toBe('result');
    expect(message.messageBody.error).toBeDefined();
    expect(message.messageBody.return).toBeDefined();
    expect(message.messageBody.value).toBeDefined();
  });

  it('creates message with empty result', () => {
    const message = new ResultMessage({});
    expect(message.messageType).toBe('result');
    expect(message.messageBody.error).toBeUndefined();
    expect(message.messageBody.return).toBeUndefined();
    expect(message.messageBody.value).toBeUndefined();
  });

  it('compresses long output by default', () => {
    const message = new ResultMessage({ value: { output: longValue } });
    const replString = message.toReplString();
    expect(replString.split('\n').length).toBeLessThan(60);
    expect(replString).toContain('// ...');
  });

  it.each([
    ['long error', { [ERROR]: new Error(longString) }],
    ['long return', { [RETURN]: longString }],
  ])('compresses %s by default', (_, result) => {
    const message = new ResultMessage(result);
    const replString = message.toReplString();
    expect(replString.split('\n').length).toBeLessThan(30);
  });

  it('does not compress when disabled', () => {
    const message = new ResultMessage(
      { value: { output: longValue } },
      { compress: false },
    );
    const replString = message.toReplString();
    expect(replString.split('\n').length).toBeGreaterThan(30);
    expect(replString).not.toContain('// ...');
  });

  it('handles multiline values', () => {
    const message = new ResultMessage({
      value: { a: 'line1\nline2\nline3', b: 'single' },
    });
    expect(message.messageBody.value).toContain('line1');
    expect(message.messageBody.value).toContain('line3');
  });

  it('serializes to JSON', () => {
    const message = new ResultMessage({ [RETURN]: 'test' });
    expect(message.toJsonString()).toBe('{ "messageType": "result",  }');
  });
});

describe('ReplMessage toJsonString', () => {
  it('filters non-JsonObservable and includes JsonObservable values', () => {
    const message = new InterjectionMessage('test');
    expect(message.toJsonString()).not.toContain('node');
    const observable = { toJsonString: () => '"custom"' };
    (
      message as { messageBody: { test?: typeof observable } }
    ).messageBody.test = observable;
    expect(message.toJsonString()).toContain('"test": "custom"');
  });
});
