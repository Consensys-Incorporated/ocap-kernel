# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `makeKernelParserService` and `makeParserClient`, so a host can offer its native tree-sitter parser to vats as a kernel service and a vat can hand `makeReplAgent` a client for it ([#1239](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1239))
  - The native binding stays out of the main entry point so the agent can be bundled into a vat. `@ocap/kernel-agents-repl/parser/tree-sitter-worker` exports `makeTreeSitterWorkerParser`, which runs the binding in a worker thread because it cannot initialize in a locked-down realm; `@ocap/kernel-agents-repl/parser/tree-sitter` exports `makeTreeSitterParser` for a realm that has not run lockdown

### Changed

- **BREAKING:** `makeReplAgent` requires a `parser`, and statements are parsed asynchronously in the reader rather than in message constructors. `StatementMessage.fromCode` takes the parser and returns a promise, and a statement constructed without a parsed node is a transcript-only message that the evaluator rejects ([#1239](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1239))
- The REPL no longer loads `ses` itself; it uses the `Compartment` global of the realm that ran lockdown, so it can be bundled into a vat and run under `endoify` in tests ([#1239](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1239))

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/
