# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `rollbackSavepoint` discards the enclosing transaction when `ROLLBACK TO` itself fails, instead of leaving the savepoint on its stack and the transaction open ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - Nothing would ever commit or abort that transaction, so every later write on the connection silently joined it, reported success, and vanished on close. Discarding it is no wider than the caller asked for: the transaction begins with the outermost savepoint, so it holds only the work the rollback was abandoning
  - The rollback failure is still what gets thrown, even if aborting the transaction fails too
- `releaseSavepoint` discards the enclosing transaction when `RELEASE` itself fails, the same way `rollbackSavepoint` already did when `ROLLBACK TO` failed ([#1012](https://github.com/MetaMask/ocap-kernel/pull/1012))
  - The same hazard by the other door: the savepoint stayed on the stack and the transaction stayed open with nothing left that would ever commit or abort it. The release failure is what gets thrown, even if aborting fails too
- The wasm driver leaves `_inTx` false when aborting a transaction throws, rather than believing it is still in one ([#1012](https://github.com/MetaMask/ocap-kernel/pull/1012))
  - It tracks `_inTx` itself instead of reading it from SQLite, so a throwing abort was the one case that could leave the two disagreeing. Left true, `beginIfNeeded` became a permanent no-op and later writes autocommitted a statement at a time; left false, the next `BEGIN` fails loudly if SQLite really is still in a transaction. The nodejs driver reads `db.inTransaction` and was never affected
- An abort that fails while recovering from a failed savepoint operation is logged, in both drivers ([#1012](https://github.com/MetaMask/ocap-kernel/pull/1012))
  - The savepoint failure is still the one thrown, but the abandoned transaction it leaves behind was previously silent

## [0.6.0]

### Changed

- **BREAKING:** Remove `store.kv` property and adopt branded string types for kernel identifiers ([#917](https://github.com/MetaMask/ocap-kernel/pull/917))

## [0.5.0]

### Added

- Support absolute database paths ([#821](https://github.com/MetaMask/ocap-kernel/pull/821))
- Add `close()` method to `KernelDatabase` ([#692](https://github.com/MetaMask/ocap-kernel/pull/692))

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))

## [0.4.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))

## [0.3.0]

### Changed

- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590), [#543](https://github.com/MetaMask/ocap-kernel/pull/543))
- Use `@metamask/logger` ([#559](https://github.com/MetaMask/ocap-kernel/pull/559))

## [0.2.0]

### Added

- Make export paths compatible with Browserify ([#533](https://github.com/MetaMask/ocap-kernel/pull/533))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-store@0.6.0...HEAD
[0.6.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-store@0.5.0...@metamask/kernel-store@0.6.0
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-store@0.4.0...@metamask/kernel-store@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-store@0.3.0...@metamask/kernel-store@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-store@0.2.0...@metamask/kernel-store@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-store@0.1.0...@metamask/kernel-store@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-store@0.1.0
