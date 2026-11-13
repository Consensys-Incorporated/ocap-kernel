import { stringify } from '@metamask/kernel-utils';
import { Message } from '@ocap/kernel-agents/types/messages';
import type { Transcript } from '@ocap/kernel-agents/types/messages';
import type { SyntaxNode } from 'tree-sitter';

import { makeCompartment } from './compartment.ts';
import { parse } from './parse/javascript.ts';
import { ERROR, RETURN } from './symbols.ts';

export type StatementType = 'import' | 'evaluation' | 'comment';

export type ReplMessageType = StatementType | 'interjection' | 'result';

export type ReplObservable = {
  toReplString(): string;
};

export type JsonObservable = {
  toJsonString(): string;
};

type JsonKey = string | number;

type Primitive = string | number | boolean | null | undefined;

type JsonObservation =
  | Primitive
  | JsonObservable
  | JsonObservation[]
  | { [key: JsonKey]: JsonObservation };

const isJsonObservable = (value: unknown): value is JsonObservable =>
  typeof value === 'object' && value !== null && 'toJsonString' in value;

export const observeJson = (value: JsonObservation): string =>
  isJsonObservable(value) ? value.toJsonString() : stringify(value);

/**
 * An abstract REPL message with JSON and REPL string serialization capabilities.
 */
export abstract class ReplMessage<
  Type extends ReplMessageType,
  Body extends Record<JsonKey, JsonObservation | SyntaxNode>,
>
  extends Message<Type, Body>
  implements ReplObservable, JsonObservable
{
  /**
   * Serializes the message to a JSON-formatted string.
   *
   * @returns The JSON string representation of the message.
   */
  toJsonString(): string {
    const messageType = `"messageType": "${this.messageType}"`;
    const bodyEntries = Object.entries(this.messageBody)
      .filter(([, value]) => isJsonObservable(value))
      .map(
        ([key, value]) => `"${key}": ${observeJson(value as JsonObservation)}`,
      );
    return `{ ${messageType}, ${bodyEntries.join(', ')} }`;
  }

  abstract toReplString(): string;
}

// Statements comprise the action space of the REPL agent.
/**
 * A message representing a statement in the REPL action space.
 */
export class StatementMessage<
  Type extends StatementType = StatementType,
> extends ReplMessage<Type, { code: string; node: SyntaxNode }> {
  /**
   * Serializes the statement to a REPL-formatted string with prompt prefix.
   *
   * @returns The REPL string representation of the statement.
   */
  toReplString(): string {
    return `> ${this.messageBody.code}`;
  }

  /**
   * Creates a statement message from code by parsing it and determining its type.
   *
   * @param code - The code string to parse into a statement message.
   * @returns A statement message of the appropriate type.
   */
  static fromCode(code: string): StatementMessage {
    return statementMessageFromCode(code);
  }
}

const parseStatement = (
  code: string,
  name?: string,
  bound?: StatementType[],
): SyntaxNode => {
  const { rootNode } = parse(code);
  const [statement] = rootNode.children as [SyntaxNode];
  if (bound && !bound.includes(statement.type as StatementType)) {
    throw new Error(`"${code}" is not a valid ${name}.`);
  }
  return statement;
};

/**
 * A message representing a comment statement.
 */
export class CommentMessage extends StatementMessage<'comment'> {
  /**
   * Constructs a new {@link CommentMessage}.
   *
   * @param code - The comment code string.
   * @param statement - Optional pre-parsed syntax node; if not provided, the code will be parsed.
   */
  constructor(code: string, statement?: SyntaxNode) {
    const node = statement ?? parseStatement(code, 'comment');
    super('comment', { code, node });
  }
}

/**
 * A message representing an import statement.
 */
export class ImportMessage extends StatementMessage<'import'> {
  /**
   * Constructs a new {@link ImportMessage}.
   *
   * @param code - The import statement code string.
   * @param statement - Optional pre-parsed syntax node; if not provided, the code will be parsed.
   */
  constructor(code: string, statement?: SyntaxNode) {
    const node = statement ?? parseStatement(code, 'import_statement');
    super('import', { code, node });
  }

  /**
   * Creates an import message from a list of named imports from the abilities module.
   *
   * @param names - The names to import from the abilities module.
   * @returns An import message for the specified names.
   */
  static fromNames(names: string[]): ImportMessage {
    const code = `import { ${names.join(', ')} } from "@ocap/abilities";`;
    return new ImportMessage(code);
  }
}

/**
 * A message representing an evaluation statement to be executed.
 */
export class EvaluationMessage extends StatementMessage<'evaluation'> {
  /**
   * Constructs a new {@link EvaluationMessage}.
   *
   * @param code - The code to evaluate.
   * @param statement - Optional pre-parsed syntax node; if not provided, the code will be parsed.
   */
  constructor(code: string, statement?: SyntaxNode) {
    const node = statement ?? parseStatement(code, 'expression_statement');
    super('evaluation', { code, node });
  }
}

/**
 * Make a statement message from code.
 *
 * @param code - The code to parse.
 * @returns A statement message.
 */
function statementMessageFromCode(code: string): StatementMessage {
  const { rootNode } = parse(code);
  const [statement] = rootNode.children as [SyntaxNode];
  switch (statement.type) {
    case 'comment':
      return new CommentMessage(code, statement);
    case 'import_statement':
      return new ImportMessage(code, statement);
    default: // XXX Maybe too permissive as the default case.
      return new EvaluationMessage(code, statement);
  }
}

/**
 * A message representing an interjection in the REPL session.
 */
export class InterjectionMessage extends ReplMessage<
  'interjection',
  { interjection: string }
> {
  /**
   * Constructs a new {@link InterjectionMessage}.
   *
   * @param interjection - The interjection text to display.
   */
  constructor(interjection: string) {
    super('interjection', { interjection });
  }

  /**
   * Serializes the interjection to a REPL-formatted string with exclamation prefix.
   *
   * @returns The REPL string representation of the interjection.
   */
  toReplString(): string {
    return `! ${this.messageBody.interjection}`;
  }
}

const $stringify = harden(stringify);

export const MAX_LINES = 20;
const HEAD_LENGTH = 14;
const ELLIPSIS = '// ...';

const hardenEntry = ([key, value]: [string, unknown]): [string, string] => {
  const hardValue = harden(value);
  const compartment = makeCompartment({ hardValue, $stringify });
  const stringified = compartment.evaluate('$stringify(hardValue);') as string;
  return [key, stringified];
};

type ResultMessageBody = { value?: string; error?: string; return?: string };

const compressLines = (
  lines: string[],
  {
    maxLines = MAX_LINES,
    headLength = HEAD_LENGTH,
    ellipsis = ELLIPSIS,
  }: { maxLines?: number; headLength?: number; ellipsis?: string } = {},
): string[] =>
  lines.length > maxLines
    ? [
        ...lines.slice(0, headLength),
        ellipsis,
        ...lines.slice(-(maxLines - headLength - 1)),
      ]
    : lines;

type ResultArg = {
  value?: Record<string, unknown>;
  [ERROR]?: unknown;
  [RETURN]?: unknown;
};

/**
 * A message representing the result of evaluating a statement.
 */
export class ResultMessage extends ReplMessage<'result', ResultMessageBody> {
  readonly #compress: boolean;

  /**
   * Constructs a new {@link ResultMessage}.
   *
   * @param result - The result object containing optional value, error, or return properties.
   * @param options - Configuration options for the result message.
   * @param options.compress - Whether to compress long output by truncating lines; defaults to true.
   */
  constructor(
    result: ResultArg,
    { compress = true }: { compress?: boolean } = {},
  ) {
    const messageBody: ResultMessageBody = {};
    if (Object.hasOwn(result, ERROR)) {
      const error = result[ERROR] as Error;
      messageBody.error = `${error.name}: ${error.message}`;
    }
    if (Object.hasOwn(result, RETURN)) {
      messageBody.return = hardenEntry(['', result[RETURN]])[1];
    }
    if (Object.hasOwn(result, 'value')) {
      messageBody.value = Object.entries(
        result.value as Record<string, unknown>,
      )
        .map(hardenEntry)
        .map(([key, val]) => `${key}: ${val}`)
        .join('\n');
    }
    super('result', messageBody);
    this.#compress = compress;
  }

  /**
   * Serializes the result to a REPL-formatted string, optionally compressing long output.
   *
   * @returns The REPL string representation of the result.
   */
  toReplString(): string {
    const lines = {
      error: this.messageBody.error?.split('\n') ?? [],
      return: this.messageBody.return?.split('\n') ?? [],
      value: this.messageBody.value?.split('\n') ?? [],
    };
    const transform = this.#compress
      ? compressLines
      : (value: string[]) => value;
    return [
      ...transform(lines.error),
      ...transform(lines.return),
      ...transform(lines.value),
    ].join('\n');
  }
}

export type ReplTranscript = Transcript<ReplMessageType, ReplObservable>;

export type Observation = InterjectionMessage | ResultMessage;

export type Action = StatementMessage;

export type State = (Observation | Action)[];
