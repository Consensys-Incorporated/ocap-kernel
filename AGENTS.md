Documentation:

- Check the [glossary](./docs/glossary.md) for definitions of unclear terms.

Development workflows:

- This is a Node.js monorepo managed with Yarn workspaces
- Always use `yarn` to execute installed packages, e.g. `yarn vitest ...`; only use npx
  for packages that aren't already installed
- Published packages are prefixed with `@metamask/`, private packages with `@ocap/`
- Use `yarn` and `yarn workspace` to run package scripts:
  - `lint:fix` for linting
  - `test:dev:quiet` for unit tests, add `--coverage=true` to include coverage
  - if available, integration and e2e tests invoked separately via
    `test:integration` and `test:e2e`, respectively
  - `build`, `build:dev`, `test:dev`, and `test:dev:quiet` from root are cached using Turborepo (`turbo`)
    - No other scripts use `turbo`
- When adding another monorepo package as a dependency, also add it to
  `references` in both `tsconfig.json` and `tsconfig.build.json`

General conventions:

- Comments, changelog entries, and PR bodies follow
  [`.claude/skills/prose-pass/SKILL.md`](./.claude/skills/prose-pass/SKILL.md); apply it to
  a diff before presenting it (in Claude Code, via the `prose-pass` skill)
- Use `@metamask/superstruct` for runtime type checking and to define object types
- kebab-case for package and file names (`@ocap/test-utils`, `kernel-worker.js`, `vat.js`)
- If a function has more than two arguments or could be expected to grow thereto,
  give it an options bag (i.e. named parameters)

Object capability (ocap) patterns:

- Production code must run under "lockdown" from `@endo/lockdown` / `ses` via the local `@metamask/kernel-shims` package
  — Many `@endo/*` packages fail silently or throw in non-locked-down environments
  - Lockdown must be the first thing that runs in the given JavaScript realm for it to work
  - Use "development" mode (per-package) only for local debugging; it disables lockdown and
    coverage and does not run in CI
  - Some tests use a mock shim from `@ocap/repo-tools/test-utils/mock-endoify` for test runner compatibility
- Use `harden()` (globally available via lockdown) for immutability where feasible:
  - Harden class instances: `harden(this)` at the end of constructors
  - Harden classes: `harden(ClassName)` after the class definition
  - Harden returned object literals inline: `return harden({ ... })`
- Use `E()` from `@endo/eventual-send` to:
  - Communicate with objects between vats or between processes with a CapTP connection
  - Queue messages on a promise (that resolves to some object with methods)
- If an object is to be made remotable, turn it into an exo using the internal `makeDefaultExo`
  which builds on `@endo/exo`
  - Do not use `Far` from `@endo/far`
  - It's fine to use `E()` on local objects that aren't exos

Testing:

- Use `vitest` for testing
- Check `@ocap/test-utils` before creating test helpers
- Avoid introducing global state in tests
  - If you need a mock object of type `Foo`, add a utility like `const makeFoo = () => { ... }`
- Avoid negative cases, but if you must, use "does not" instead of "should not" (e.g., `it('does not duplicate relays', ...)`)
- If testing all properties of an object, use a single `toStrictEqual()` on the entire object
  instead of multiple `expect()` calls
- Prefer `it.each()` for parameterized tests
- Test titles should use concise verb forms without "should" (e.g., `it('creates and starts libp2p node', ...)` not `it('should create and start libp2p node', ...)`)
- Use `vi.useFakeTimers()` for tests that rely on timers
- Do not assert an exo guard refusal with `rejects.toThrow`: under `mock-endoify` a
  guard violation rejects with `undefined`, which satisfies every matcher, so the
  assertion passes with the guard removed too. Assert an observable consequence
  instead, such as the guarded method never running

TypeScript:

- Prefer `type`; do not use `interface` declarations
- Prefer `#` private fields over `private` class fields
- Never use the `any` type
- Never use `enum`:s; always use string literal unions instead

File and directory structure:

- Co-locate a package's unit tests with their covered source files in the `<package-root>/src/` directory (e.g. `ocap-kernel/src/kernel-worker.ts` should be tested in `ocap-kernel/src/kernel-worker.test.ts`)
- Test utilities used by a single package should be separated into that package's `<package-root>/test/` directory
- Test utilities used by multiple packages should be relocated into the dedicated `test-utils` package
