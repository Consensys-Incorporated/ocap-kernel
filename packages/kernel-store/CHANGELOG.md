# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `rollbackSavepoint` discards the enclosing transaction when `ROLLBACK TO` itself fails, instead of leaving the savepoint on its stack and the transaction open ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - Nothing would ever commit or abort that transaction, so every later write on the connection silently joined it, reported success, and vanished on close. Discarding it is no wider than the caller asked for: the transaction begins with the outermost savepoint, so it holds only the work the rollback was abandoning
  - The rollback failure is still what gets thrown, even if aborting the transaction fails too
- `releaseSavepoint` discards the enclosing transaction when `RELEASE` fails, as `rollbackSavepoint` already did for `ROLLBACK TO`; the release failure is still what gets thrown ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
- The wasm driver no longer considers itself in a transaction after a commit or abort throws, and discards the transaction a failed `COMMIT` leaves open ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
  - Otherwise later writes autocommitted — including the next savepoint, created bare, where `RELEASE` commits and no rollback can undo the work. The nodejs driver reads `db.inTransaction` and was never affected
- Both drivers log an abort that fails while recovering from a failed savepoint operation ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))

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
