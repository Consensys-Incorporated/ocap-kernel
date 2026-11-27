# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Statements are parsed in the reader rather than in message constructors, and a statement constructed without a parsed node is a transcript-only message that the evaluator rejects ([#1255](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1255))
- The REPL no longer loads `ses` itself; it uses the `Compartment` global of the realm that ran lockdown, so it can be bundled into a vat ([#1255](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1255))
- Parse statements with acorn instead of tree-sitter, so the package has no native dependency ([#1332](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1332))
- A sample that does not parse is resampled; a syntax error in its first statement used to fail the attempt ([#1332](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1332))

### Fixed

- A default's value in a destructuring declaration is no longer declared: `const { a: b = c } = o` declares only `b` ([#1332](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1332))

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/
