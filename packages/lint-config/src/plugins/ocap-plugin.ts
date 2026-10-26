import type { RuleTester } from 'oxlint/plugins-dev';

// oxlint does not export its plugin types by name, so derive them from the
// `RuleTester.run()` signature.
type Rule = Parameters<RuleTester['run']>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>['create']>[0];
type Visitor = ReturnType<Extract<Rule, { create: unknown }>['create']>;
type VisitedNode = NonNullable<Parameters<Context['report']>[0]['node']>;
type SourceCode = Context['sourceCode'];
type NodeOrToken = Parameters<SourceCode['getTokenBefore']>[0];
type Fixer = Parameters<
  NonNullable<Parameters<Context['report']>[0]['fix']>
>[0];

/**
 * A restriction entry, as accepted by ESLint's core `no-restricted-syntax`:
 * a bare selector, or a selector with a custom message.
 */
export type RestrictedSyntaxEntry =
  | string
  | { selector: string; message?: string };

/**
 * Port of ESLint's core `no-restricted-syntax`, which oxlint does not
 * implement natively. Takes the same options and reports the same default
 * message.
 */
const noRestrictedSyntax: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow specified syntax',
    },
    messages: {
      restrictedSyntax: '{{message}}',
    },
    schema: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['selector'],
            additionalProperties: false,
          },
        ],
      },
      uniqueItems: true,
      minItems: 0,
    },
  },

  create(context: Context): Visitor {
    const visitor: Record<string, (node: VisitedNode) => void> = {};
    for (const entry of context.options as RestrictedSyntaxEntry[]) {
      const selector = typeof entry === 'string' ? entry : entry.selector;
      const message =
        typeof entry === 'string' || !entry.message
          ? `Using '${selector}' is not allowed.`
          : entry.message;
      // As in ESLint, a repeated selector replaces the earlier entry.
      visitor[selector] = (node: VisitedNode): void => {
        context.report({
          node,
          messageId: 'restrictedSyntax',
          data: { message },
        });
      };
    }
    return visitor;
  },
};

/**
 * The ESTree node fields that `ocap/require-jsdoc` reads.
 */
type AstNode = {
  type: string;
  range: [number, number];
  loc: { start: LineColumn; end: LineColumn };
  parent?: AstNode | null;
  kind?: string;
  key?: { name?: string } | null;
  value?: AstNode | null;
  decorators?: AstNode[];
  declaration?: AstNode | null;
  params?: AstNode[];
  properties?: AstNode[];
  body?: AstNode | AstNode[] | null;
  expression?: boolean;
  callee?: { type: string; name?: string } | null;
  typeArguments?: { params?: AstNode[] } | null;
  argument?: AstNode | null;
  consequent?: AstNode | AstNode[] | null;
  alternate?: AstNode | null;
  block?: AstNode | null;
  handler?: AstNode | null;
  finalizer?: AstNode | null;
  cases?: AstNode[];
};

type LineColumn = { line: number; column: number };

/** A token or comment, as returned by the `SourceCode` token methods. */
type Token = {
  type: string;
  value: string;
  range: [number, number];
  loc: { start: LineColumn; end: LineColumn };
};

type RequireJsdocKind =
  | 'ArrowFunctionExpression'
  | 'ClassDeclaration'
  | 'ClassExpression'
  | 'FunctionDeclaration'
  | 'FunctionExpression'
  | 'MethodDefinition';

/**
 * Options for `ocap/require-jsdoc`, a subset of `eslint-plugin-jsdoc`'s
 * `require-jsdoc` options.
 */
export type RequireJsdocOptions = {
  require?: Partial<Record<RequireJsdocKind, boolean>>;
  contexts?: string[];
  checkConstructors?: boolean;
  checkGetters?: boolean | 'no-setter';
  checkSetters?: boolean | 'no-getter';
  exemptEmptyConstructors?: boolean;
  exemptEmptyFunctions?: boolean;
  enableFixer?: boolean;
  fixerMessage?: string;
};

type ResolvedRequireJsdocOptions = Required<
  Omit<RequireJsdocOptions, 'require'>
> & { require: Record<RequireJsdocKind, boolean> };

// eslint-plugin-jsdoc's defaults for the `jsdoc.minLines` and `jsdoc.maxLines`
// settings, which this repo does not set: the JSDoc block may end on the line
// before the node or on the node's own line.
const MIN_LINES = 0;
const MAX_LINES = 1;

const assignmentParents = new Set([
  'VariableDeclarator',
  'AssignmentExpression',
  'ExportDefaultDeclaration',
]);
const propertyParents = new Set([
  'Property',
  'ObjectProperty',
  'ClassProperty',
  'PropertyDefinition',
]);
const invokedExpressions = new Set([
  'CallExpression',
  'OptionalCallExpression',
  'NewExpression',
]);
const allowableCommentNodes = new Set([
  'AssignmentPattern',
  'VariableDeclaration',
  'ExpressionStatement',
  'MethodDefinition',
  'Property',
  'ObjectProperty',
  'ClassProperty',
  'PropertyDefinition',
  'ExportDefaultDeclaration',
  'ReturnStatement',
]);
const exportDeclarations = new Set([
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ExportSpecifier',
]);
const loopLikeStatements = new Set([
  'LabeledStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WithStatement',
]);

/**
 * Resolve `ocap/require-jsdoc` options against the schema defaults ESLint
 * filled in for `eslint-plugin-jsdoc`.
 *
 * @param options - The rule's first option, if any.
 * @returns The options with every key set.
 */
const resolveRequireJsdocOptions = (
  options: RequireJsdocOptions = {},
): ResolvedRequireJsdocOptions => ({
  require: {
    ArrowFunctionExpression: false,
    ClassDeclaration: false,
    ClassExpression: false,
    FunctionDeclaration: true,
    FunctionExpression: false,
    MethodDefinition: false,
    ...options.require,
  },
  contexts: options.contexts ?? [],
  checkConstructors: options.checkConstructors ?? true,
  checkGetters: options.checkGetters ?? true,
  checkSetters: options.checkSetters ?? true,
  exemptEmptyConstructors: options.exemptEmptyConstructors ?? false,
  exemptEmptyFunctions: options.exemptEmptyFunctions ?? false,
  enableFixer: options.enableFixer ?? true,
  fixerMessage: options.fixerMessage ?? '',
});

/**
 * View a visited node through the fields this rule reads.
 *
 * @param node - The visited node.
 * @returns The same node.
 */
const asAstNode = (node: VisitedNode): AstNode => node as unknown as AstNode;

/**
 * View a node or token as the argument type of the `SourceCode` token methods.
 *
 * @param item - The node or token.
 * @returns The same node or token.
 */
const asNodeOrToken = (item: AstNode | Token): NodeOrToken =>
  item as unknown as NodeOrToken;

/**
 * @param item - A node, token, or comment.
 * @returns Whether `item` is a comment.
 */
const isComment = (item: AstNode | Token): item is Token =>
  item.type === 'Line' || item.type === 'Block' || item.type === 'Shebang';

/**
 * @param left - A node.
 * @param right - Another node, if any.
 * @returns Whether both are the same source node. Compares ranges rather than
 * object identity, which oxlint's lazily built AST does not promise.
 */
const isSameNode = (
  left: AstNode,
  right: AstNode | null | undefined,
): boolean =>
  right?.range[0] === left.range[0] && right.range[1] === left.range[1];

/**
 * Port of `getDecorator` from `@es-joy/jsdoccomment`.
 *
 * @param node - A node.
 * @returns The first decorator on the node, its declaration, or its parent.
 */
const getDecorator = (node: AstNode): AstNode | undefined =>
  node.declaration?.decorators?.[0] ??
  node.decorators?.[0] ??
  node.parent?.decorators?.[0];

/**
 * @param sourceCode - The file's source code.
 * @param item - A node or token.
 * @returns The token or comment before `item`, if any.
 */
const getTokenOrCommentBefore = (
  sourceCode: SourceCode,
  item: AstNode | Token,
): Token | null =>
  sourceCode.getTokenBefore(asNodeOrToken(item), { includeComments: true });

/**
 * @param sourceCode - The file's source code.
 * @param node - A node.
 * @returns Whether any comment directly precedes `node`.
 */
const hasCommentsBefore = (sourceCode: SourceCode, node: AstNode): boolean =>
  sourceCode.getCommentsBefore(asNodeOrToken(node)).length > 0;

/**
 * The expression branch of `getReducedNode`.
 *
 * @param options - Options bag.
 * @param options.node - The expression to document.
 * @param options.expressionParent - The expression's parent.
 * @param options.sourceCode - The file's source code.
 * @returns The node to look for a leading JSDoc comment on.
 */
const getReducedExpression = ({
  node,
  expressionParent,
  sourceCode,
}: {
  node: AstNode;
  expressionParent: AstNode;
  sourceCode: SourceCode;
}): AstNode => {
  if (invokedExpressions.has(expressionParent.type)) {
    return node;
  }
  let token: AstNode | Token | null = node;
  do {
    token = getTokenOrCommentBefore(sourceCode, token);
  } while (token?.type === 'Punctuator' && token.value === '(');
  if (token?.type === 'Block' || hasCommentsBefore(sourceCode, node)) {
    return node;
  }

  let parent: AstNode | null | undefined = expressionParent;
  while (
    parent &&
    !hasCommentsBefore(sourceCode, parent) &&
    !/Function/u.test(parent.type) &&
    !allowableCommentNodes.has(parent.type)
  ) {
    parent = parent.parent;
  }
  if (
    parent &&
    parent.type !== 'FunctionDeclaration' &&
    parent.type !== 'Program'
  ) {
    return parent.parent?.type === 'ExportNamedDeclaration'
      ? parent.parent
      : parent;
  }
  return node;
};

/**
 * Port of `getReducedASTNode` from `@es-joy/jsdoccomment`: find the node whose
 * leading comment documents `node`. Declarations reduce to their `export`
 * wrapper, and function or class expressions to the declaration, property,
 * or statement that holds them.
 *
 * @param node - The node to document.
 * @param sourceCode - The file's source code.
 * @returns The node to look for a leading JSDoc comment on.
 */
const getReducedNode = (node: AstNode, sourceCode: SourceCode): AstNode => {
  const { parent } = node;
  if (!parent) {
    return node;
  }
  switch (node.type) {
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
    case 'ClassDeclaration':
    case 'FunctionDeclaration':
      return exportDeclarations.has(parent.type) ? parent : node;
    case 'TSDeclareFunction':
    case 'ClassExpression':
    case 'ObjectExpression':
    case 'ArrowFunctionExpression':
    case 'TSEmptyBodyFunctionExpression':
    case 'FunctionExpression':
      return getReducedExpression({
        node,
        expressionParent: parent,
        sourceCode,
      });
    default:
      return node;
  }
};

/**
 * Port of `findJSDocComment` from `@es-joy/jsdoccomment`. Skips decorators,
 * one opening parenthesis, and line comments, then accepts a `/** ` block
 * comment that ends within {@link MAX_LINES} lines of the node.
 *
 * @param node - The reduced node.
 * @param sourceCode - The file's source code.
 * @returns The JSDoc comment, or `null` if there is none.
 */
const findJsdocComment = (
  node: AstNode,
  sourceCode: SourceCode,
): Token | null => {
  let current: AstNode | Token = node;
  let parenthesis: Token | null = null;
  for (;;) {
    if (!isComment(current)) {
      current = getDecorator(current) ?? current;
    }
    let before = getTokenOrCommentBefore(sourceCode, current);
    if (before?.type === 'Punctuator' && before.value === '(') {
      parenthesis = before;
      [before = null] = sourceCode.getTokensBefore(asNodeOrToken(current), {
        count: 2,
        includeComments: true,
      });
    }
    if (!before || !isComment(before)) {
      return null;
    }
    if (before.type === 'Line') {
      current = before;
      continue;
    }
    const gap = current.loc.start.line - (parenthesis ?? before).loc.end.line;
    return before.type === 'Block' &&
      /^\*\s/u.test(before.value) &&
      gap >= MIN_LINES &&
      gap <= MAX_LINES
      ? before
      : null;
  }
};

/**
 * @param node - A checked node.
 * @returns Whether `node` is a constructor or a constructor's function.
 */
const isConstructor = (node: AstNode): boolean =>
  (node.type === 'MethodDefinition' && node.kind === 'constructor') ||
  node.parent?.kind === 'constructor';

/**
 * @param method - A getter or setter method or property.
 * @returns Whether the class or object also has the opposite accessor for the
 * same key.
 */
const hasAccessorPair = (method: AstNode): boolean => {
  const oppositeKind = method.kind === 'get' ? 'set' : 'get';
  const siblings =
    method.type === 'MethodDefinition'
      ? method.parent?.body
      : method.parent?.properties;
  return (
    Array.isArray(siblings) &&
    siblings.some(
      (sibling) =>
        sibling.kind === oppositeKind && sibling.key?.name === method.key?.name,
    )
  );
};

/**
 * Port of `exemptSpeciaMethods` from `eslint-plugin-jsdoc`, without its
 * `@class` and `@constructor` tag check, which never applies to an
 * undocumented node.
 *
 * @param node - A checked node.
 * @param options - The resolved rule options.
 * @returns Whether `node` is a constructor, getter, or setter the options
 * exempt.
 */
const isExemptSpecialMethod = (
  node: AstNode,
  options: ResolvedRequireJsdocOptions,
): boolean => {
  const { checkConstructors, checkGetters, checkSetters } = options;
  const { parent } = node;
  if (!checkConstructors && isConstructor(node)) {
    return true;
  }
  if (parent?.kind === 'get') {
    return (
      !checkGetters || (checkGetters === 'no-setter' && hasAccessorPair(parent))
    );
  }
  if (parent?.kind === 'set') {
    return (
      !checkSetters || (checkSetters === 'no-getter' && hasAccessorPair(parent))
    );
  }
  return false;
};

/**
 * @param node - A function body expression.
 * @returns Whether `node` is `new Promise<void>(...)`.
 */
const isVoidPromiseExpression = (node: AstNode): boolean =>
  node.type === 'NewExpression' &&
  node.callee?.type === 'Identifier' &&
  node.callee.name === 'Promise' &&
  node.typeArguments?.params?.[0]?.type === 'TSVoidKeyword';

/**
 * @param value - A node field.
 * @returns The field if it holds a single node.
 */
const single = (
  value: AstNode | AstNode[] | null | undefined,
): AstNode | undefined =>
  Array.isArray(value) ? undefined : (value ?? undefined);

/**
 * @param value - A node field.
 * @returns The field if it holds a node list, otherwise an empty list.
 */
const many = (value: AstNode | AstNode[] | null | undefined): AstNode[] =>
  Array.isArray(value) ? value : [];

/**
 * Port of `hasReturnValue` from `eslint-plugin-jsdoc` for function nodes: an
 * expression body or a `return` with an argument counts, and a bare `return`
 * or a nested function's `return` does not.
 *
 * @param node - A function or statement.
 * @returns Whether `node` can return a value.
 */
const hasReturnValue = (node: AstNode | null | undefined): boolean => {
  if (!node) {
    return false;
  }
  switch (node.type) {
    case 'MethodDefinition':
      return hasReturnValue(node.value);
    case 'FunctionExpression':
    case 'FunctionDeclaration':
    case 'ArrowFunctionExpression': {
      const body = single(node.body);
      return (
        (node.expression === true &&
          body !== undefined &&
          !isVoidPromiseExpression(body)) ||
        hasReturnValue(body)
      );
    }
    case 'BlockStatement':
      return many(node.body).some(
        (child) =>
          child.type !== 'FunctionDeclaration' && hasReturnValue(child),
      );
    case 'IfStatement':
      return (
        hasReturnValue(single(node.consequent)) ||
        hasReturnValue(node.alternate)
      );
    case 'TryStatement':
      return (
        hasReturnValue(node.block) ||
        hasReturnValue(single(node.handler?.body)) ||
        hasReturnValue(node.finalizer)
      );
    case 'SwitchStatement':
      return (node.cases ?? []).some((switchCase) =>
        many(switchCase.consequent).some(hasReturnValue),
      );
    case 'ReturnStatement':
      return node.argument !== null && node.argument !== undefined;
    default:
      return loopLikeStatements.has(node.type)
        ? hasReturnValue(single(node.body))
        : false;
  }
};

/**
 * Port of `eslint-plugin-jsdoc`'s `require-jsdoc`, which oxlint does not
 * implement natively. Supports the options in {@link RequireJsdocOptions} with
 * the same defaults; `publicOnly`, `minLineCount`, and object `contexts`
 * entries are not supported.
 */
const requireJsdoc: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require JSDoc comments',
    },
    fixable: 'code',
    messages: {
      missingJsDoc: 'Missing JSDoc comment.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          require: {
            type: 'object',
            properties: {
              ArrowFunctionExpression: { type: 'boolean' },
              ClassDeclaration: { type: 'boolean' },
              ClassExpression: { type: 'boolean' },
              FunctionDeclaration: { type: 'boolean' },
              FunctionExpression: { type: 'boolean' },
              MethodDefinition: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          contexts: { type: 'array', items: { type: 'string' } },
          checkConstructors: { type: 'boolean' },
          checkGetters: {
            anyOf: [{ type: 'boolean' }, { enum: ['no-setter'] }],
          },
          checkSetters: {
            anyOf: [{ type: 'boolean' }, { enum: ['no-getter'] }],
          },
          exemptEmptyConstructors: { type: 'boolean' },
          exemptEmptyFunctions: { type: 'boolean' },
          enableFixer: { type: 'boolean' },
          fixerMessage: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
  },

  create(context: Context): Visitor {
    const { sourceCode } = context;
    const options = resolveRequireJsdocOptions(
      context.options[0] as RequireJsdocOptions | undefined,
    );

    const hasOption = (kind: string): boolean =>
      options.require[kind as RequireJsdocKind] ||
      options.contexts.includes(kind);

    const check = (node: AstNode, isFunctionContext: boolean): void => {
      if (findJsdocComment(getReducedNode(node, sourceCode), sourceCode)) {
        return;
      }
      if (isExemptSpecialMethod(node, options)) {
        return;
      }
      if (
        ((options.exemptEmptyFunctions && isFunctionContext) ||
          (options.exemptEmptyConstructors && isConstructor(node))) &&
        (node.params ?? []).length === 0 &&
        !hasReturnValue(node)
      ) {
        return;
      }
      const fix = (fixer: Fixer): ReturnType<Fixer['insertTextBefore']> => {
        const reduced = getReducedNode(node, sourceCode);
        const base = getDecorator(reduced) ?? reduced;
        const leading =
          /^\n*([ \t]+)/u.exec(
            sourceCode.getText(base, base.loc.start.column),
          )?.[1] ?? '';
        const indent = `${leading} `;
        return fixer.insertTextBefore(
          base,
          `/**\n${indent}*${options.fixerMessage}\n${indent}*/\n${leading}`,
        );
      };
      const { start } = node.loc;
      context.report({
        node,
        loc: { start, end: { line: start.line + 1, column: 0 } },
        messageId: 'missingJsDoc',
        ...(options.enableFixer ? { fix } : {}),
      });
    };

    const checkAssignedFunction = (node: AstNode, kind: string): void => {
      const { parent } = node;
      if (
        hasOption(kind) &&
        parent &&
        (assignmentParents.has(parent.type) ||
          (propertyParents.has(parent.type) && isSameNode(node, parent.value)))
      ) {
        check(node, true);
      }
    };

    const visitor: Record<string, (node: VisitedNode) => void> = {};
    for (const selector of options.contexts) {
      visitor[selector] = (node: VisitedNode): void => {
        check(asAstNode(node), false);
      };
    }
    return {
      ...visitor,
      ArrowFunctionExpression(node: VisitedNode): void {
        checkAssignedFunction(asAstNode(node), 'ArrowFunctionExpression');
      },
      ClassDeclaration(node: VisitedNode): void {
        if (hasOption('ClassDeclaration')) {
          check(asAstNode(node), false);
        }
      },
      ClassExpression(node: VisitedNode): void {
        if (hasOption('ClassExpression')) {
          check(asAstNode(node), false);
        }
      },
      FunctionDeclaration(node: VisitedNode): void {
        if (hasOption('FunctionDeclaration')) {
          check(asAstNode(node), true);
        }
      },
      FunctionExpression(node: VisitedNode): void {
        checkAssignedFunction(asAstNode(node), 'FunctionExpression');
      },
      MethodDefinition(node: VisitedNode): void {
        const { value } = asAstNode(node);
        if (hasOption('MethodDefinition') && value) {
          check(value, true);
        }
      },
    };
  },
};

const plugin = {
  meta: { name: 'ocap' },
  rules: {
    'no-restricted-syntax': noRestrictedSyntax,
    'require-jsdoc': requireJsdoc,
  },
};

export default plugin;
