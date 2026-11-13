import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';

import base from '../base.ts';
import plugin from './ocap-plugin.ts';
import type { RequireJsdocOptions } from './ocap-plugin.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const rule = plugin.rules['no-restricted-syntax'];

const privateSelector =
  "PropertyDefinition[accessibility='private'], MethodDefinition[accessibility='private'], TSParameterProperty[accessibility='private']";

describe('ocap/no-restricted-syntax', () => {
  ruleTester.run('no-restricted-syntax', rule, {
    valid: [
      { code: 'const a = (1, 2);', options: [] },
      {
        code: 'const a = 1; const b = 2;',
        options: [{ selector: 'SequenceExpression', message: 'No.' }],
      },
      {
        code: 'class A { #b = 1; c() {} }',
        filename: 'test.ts',
        options: [
          { selector: privateSelector, message: 'Use a hash name instead.' },
        ],
      },
      {
        code: "const a = 'b' in {};",
        options: [{ selector: 'SequenceExpression', message: 'No.' }],
      },
    ],
    invalid: [
      {
        code: 'const a = (1, 2);',
        options: [
          {
            selector: 'SequenceExpression',
            message: 'Sequence expressions are not allowed',
          },
        ],
        errors: [{ message: 'Sequence expressions are not allowed' }],
      },
      {
        code: 'with (a) {}',
        languageOptions: { sourceType: 'script' },
        options: [
          {
            selector: 'WithStatement',
            message: 'With statements are not allowed',
          },
        ],
        errors: [{ message: 'With statements are not allowed' }],
      },
      {
        code: 'class A { private b = 1; private c() {} constructor(private d: number) {} }',
        filename: 'test.ts',
        options: [
          { selector: privateSelector, message: 'Use a hash name instead.' },
        ],
        errors: [
          { message: 'Use a hash name instead.' },
          { message: 'Use a hash name instead.' },
          { message: 'Use a hash name instead.' },
        ],
      },
      {
        code: 'const a = (1, 2);',
        options: ['SequenceExpression'],
        errors: [{ message: "Using 'SequenceExpression' is not allowed." }],
      },
      {
        code: 'const a = (1, 2);',
        options: [{ selector: 'SequenceExpression' }],
        errors: [{ message: "Using 'SequenceExpression' is not allowed." }],
      },
      {
        code: 'const a = (1, 2);',
        options: [
          { selector: 'SequenceExpression', message: 'First.' },
          { selector: 'SequenceExpression', message: 'Second.' },
        ],
        errors: [{ message: 'Second.' }],
      },
      {
        code: 'with (a) { b = (1, 2); }',
        languageOptions: { sourceType: 'script' },
        options: [
          { selector: 'WithStatement', message: 'With.' },
          { selector: 'SequenceExpression', message: 'Sequence.' },
        ],
        errors: [{ message: 'With.' }, { message: 'Sequence.' }],
      },
    ],
  });
});

// The base layer's options, which require JSDoc on type declarations.
const [, baseOptions] = base.rules['ocap/require-jsdoc'] as [
  string,
  RequireJsdocOptions,
];

// The root config's TypeScript override, which narrows `baseOptions`. The
// root config is outside this package, so its value is repeated here.
const rootTsOptions: RequireJsdocOptions = {
  require: {
    FunctionDeclaration: true,
    MethodDefinition: true,
    ClassDeclaration: true,
  },
  contexts: [],
};

const allKinds = {
  require: {
    ArrowFunctionExpression: true,
    ClassDeclaration: true,
    ClassExpression: true,
    FunctionDeclaration: true,
    FunctionExpression: true,
    MethodDefinition: true,
  },
};

const noFixer = { ...allKinds, enableFixer: false };
const missing = [{ message: 'Missing JSDoc comment.' }];

describe('ocap/require-jsdoc', () => {
  ruleTester.run('require-jsdoc', plugin.rules['require-jsdoc'], {
    valid: [
      // Defaults require only function declarations.
      { code: 'const a = () => 1; class B { c() {} }' },
      { code: '/**\n * A.\n */\nfunction a() {}', options: [allKinds] },
      {
        code: '/**\n * A.\n */\nexport function a() {}',
        options: [allKinds],
      },
      {
        code: '/**\n * A.\n */\nexport default function a() {}',
        options: [allKinds],
      },
      {
        code: '/**\n * A.\n */\nexport const a = () => 1;',
        options: [allKinds],
      },
      {
        code: '/**\n * A.\n */\nconst a = function () {};',
        options: [allKinds],
      },
      {
        code: '/**\n * A.\n */\nexport class A {}',
        options: [allKinds],
      },
      {
        code: '/**\n * A.\n */\nconst A = class {};',
        options: [allKinds],
      },
      {
        code: 'class A {\n  /**\n   * B.\n   */\n  b() {}\n}',
        options: [{ require: { MethodDefinition: true } }],
      },
      // A JSDoc block may be followed by line comments.
      {
        code: '/**\n * A.\n */\n// eslint-disable-next-line no-empty\nfunction a() {}',
        options: [allKinds],
      },
      // A JSDoc block on a decorated class precedes the decorators.
      {
        code: 'const dec = (x: unknown) => x;\n/**\n * A.\n */\n@dec\nexport class A {}',
        filename: 'test.ts',
        options: [rootTsOptions],
      },
      // Only assigned or property-valued expressions are checked.
      { code: 'foo(() => 1, function () {});', options: [allKinds] },
      { code: 'const a = { b: () => 1 };', options: [rootTsOptions] },
      {
        code: '/**\n * A.\n */\nclass A {\n  constructor() {}\n  get b() { return 1; }\n  set b(c) {}\n}',
        options: [
          {
            ...rootTsOptions,
            checkConstructors: false,
            checkGetters: false,
            checkSetters: false,
          },
        ],
      },
      {
        code: '/**\n * A.\n */\nclass A {\n  get b() { return 1; }\n  set b(c) {}\n}',
        options: [
          {
            ...rootTsOptions,
            checkGetters: 'no-setter',
            checkSetters: 'no-getter',
          },
        ],
      },
      {
        code: 'function a() {}\n/**\n * B.\n */\nclass B {\n  constructor() {}\n}',
        options: [
          { exemptEmptyFunctions: true, exemptEmptyConstructors: true },
        ],
      },
      {
        code: 'type A = { b: string };\ninterface C {}',
        filename: 'test.ts',
        options: [rootTsOptions],
      },
      // Only the constructor is exempt, not other empty methods.
      {
        code: 'class A {\n  constructor() {}\n}',
        options: [
          {
            require: { MethodDefinition: true },
            exemptEmptyConstructors: true,
          },
        ],
      },
      {
        code: '/**\n * A.\n */\nexport default () => 1;',
        options: [allKinds],
      },
      {
        code: '/**\n * A.\n */\nexport default class {}',
        options: [allKinds],
      },
      // Overload signatures are not checked.
      {
        code: 'function a(b: string): void;\nfunction a(b: number): void;\n/**\n * A.\n */\nfunction a(b: unknown): void {}',
        filename: 'test.ts',
        options: [baseOptions],
      },
      {
        code: 'foo(/**\n * A.\n */\nclass {});',
        options: [allKinds],
      },
      { code: 'const a = /** A. */ () => 1;', options: [allKinds] },
      { code: 'const a = /** A. */ (function () {});', options: [allKinds] },
      {
        code: 'const dec = (x: unknown) => x;\n/**\n * A.\n */\nclass A {\n  /**\n   * B.\n   */\n  @dec\n  b() {}\n}',
        filename: 'test.ts',
        options: [rootTsOptions],
      },
      {
        code: '/**\n * A.\n */\ntype A = {\n  /**\n   * B.\n   */\n  b: string;\n};',
        filename: 'test.ts',
        options: [baseOptions],
      },
      {
        code: '/**\n * A.\n */\nexport interface A {}',
        filename: 'test.ts',
        options: [baseOptions],
      },
      {
        code: '/**\n * A.\n */\nexport enum A {\n  B,\n}',
        filename: 'test.ts',
        options: [baseOptions],
      },
    ],
    invalid: [
      {
        code: 'function a() {}',
        output: '/**\n *\n */\nfunction a() {}',
        errors: missing,
      },
      {
        code: 'export function a() {}',
        output: '/**\n *\n */\nexport function a() {}',
        errors: missing,
      },
      {
        code: 'export const a = () => 1;',
        output: '/**\n *\n */\nexport const a = () => 1;',
        options: [allKinds],
        errors: missing,
      },
      {
        code: 'const a = function () {};',
        output: '/**\n *\n */\nconst a = function () {};',
        options: [allKinds],
        errors: missing,
      },
      {
        code: 'class A { b = () => 1; c = function () {}; }',
        options: [
          {
            ...noFixer,
            require: { ...allKinds.require, ClassDeclaration: false },
          },
        ],
        errors: [...missing, ...missing],
      },
      {
        code: 'export class A {}',
        output: '/**\n *\n */\nexport class A {}',
        options: [allKinds],
        errors: missing,
      },
      {
        code: 'const A = class {};',
        output: '/**\n *\n */\nconst A = class {};',
        options: [allKinds],
        errors: missing,
      },
      {
        code: '/**\n * A.\n */\nclass A {\n  b() {}\n}',
        output: '/**\n * A.\n */\nclass A {\n  /**\n   *\n   */\n  b() {}\n}',
        options: [rootTsOptions],
        errors: missing,
      },
      // Getters, setters, and constructors are checked by default.
      {
        code: '/**\n * A.\n */\nclass A {\n  constructor() {}\n  get b() { return 1; }\n  set b(c) {}\n}',
        options: [{ ...rootTsOptions, enableFixer: false }],
        errors: [...missing, ...missing, ...missing],
      },
      // `no-setter` and `no-getter` exempt only paired accessors.
      {
        code: '/**\n * A.\n */\nclass A {\n  get b() { return 1; }\n  set c(d) {}\n}',
        options: [
          {
            ...rootTsOptions,
            checkGetters: 'no-setter',
            checkSetters: 'no-getter',
            enableFixer: false,
          },
        ],
        errors: [...missing, ...missing],
      },
      // A non-empty function is not exempt.
      {
        code: 'function a(b) {}\nfunction c() { return 1; }',
        options: [{ exemptEmptyFunctions: true, enableFixer: false }],
        errors: [...missing, ...missing],
      },
      // A non-JSDoc block comment does not count.
      {
        code: '/* A. */\nfunction a() {}',
        output: '/* A. */\n/**\n *\n */\nfunction a() {}',
        errors: missing,
      },
      // A JSDoc block more than one line above does not count.
      {
        code: '/**\n * A.\n */\n\nfunction a() {}',
        output: '/**\n * A.\n */\n\n/**\n *\n */\nfunction a() {}',
        errors: missing,
      },
      // The fixer inserts the stub before the decorators.
      {
        code: 'const dec = (x: unknown) => x;\n@dec\nexport class A {}',
        output:
          'const dec = (x: unknown) => x;\n/**\n *\n */\n@dec\nexport class A {}',
        filename: 'test.ts',
        options: [rootTsOptions],
        errors: missing,
      },
      // Contexts name extra node types to check.
      {
        code: 'type A = { b: string };',
        output: '/**\n *\n */\ntype A = { b: string };',
        filename: 'test.ts',
        options: [{ contexts: ['TSTypeAliasDeclaration'] }],
        errors: missing,
      },
      {
        code: 'class A {\n  constructor(a) {}\n  b() {}\n}',
        options: [
          {
            require: { MethodDefinition: true },
            exemptEmptyConstructors: true,
            enableFixer: false,
          },
        ],
        errors: [...missing, ...missing],
      },
      {
        code: 'export default () => 1;',
        output: '/**\n *\n */\nexport default () => 1;',
        options: [allKinds],
        errors: missing,
      },
      {
        code: 'export default class {}',
        output: '/**\n *\n */\nexport default class {}',
        options: [allKinds],
        errors: missing,
      },
      // Only the overloaded implementation is reported.
      {
        code: 'function a(b: string): void;\nfunction a(b: number): void;\nfunction a(b: unknown): void {}',
        output:
          'function a(b: string): void;\nfunction a(b: number): void;\n/**\n *\n */\nfunction a(b: unknown): void {}',
        filename: 'test.ts',
        options: [baseOptions],
        errors: missing,
      },
      // A class expression passed as an argument is checked.
      {
        code: 'foo(class {});',
        options: [noFixer],
        errors: missing,
      },
      {
        code: 'const dec = (x: unknown) => x;\n/**\n * A.\n */\nclass A {\n  @dec\n  b() {}\n}',
        output:
          'const dec = (x: unknown) => x;\n/**\n * A.\n */\nclass A {\n  /**\n   *\n   */\n  @dec\n  b() {}\n}',
        filename: 'test.ts',
        options: [rootTsOptions],
        errors: missing,
      },
      {
        code: '/**\n * A.\n */\ntype A = {\n  b: string;\n};',
        output:
          '/**\n * A.\n */\ntype A = {\n  /**\n   *\n   */\n  b: string;\n};',
        filename: 'test.ts',
        options: [baseOptions],
        errors: missing,
      },
      {
        code: 'export interface A {}',
        output: '/**\n *\n */\nexport interface A {}',
        filename: 'test.ts',
        options: [baseOptions],
        errors: missing,
      },
      {
        code: 'enum A {\n  B,\n}',
        output: '/**\n *\n */\nenum A {\n  B,\n}',
        filename: 'test.ts',
        options: [baseOptions],
        errors: missing,
      },
      {
        code: 'function a() {}',
        output: '/**\n * TODO\n */\nfunction a() {}',
        options: [{ fixerMessage: ' TODO' }],
        errors: missing,
      },
    ],
  });
});
