# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Export `BaseReader` and `BaseWriter` for one-way streams over any transport ([#1138](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1138))

### Changed

- **BREAKING:** `NodePort` requires an `off` method, which `NodeWorkerDuplexStream` uses to remove its listener when the stream ends ([#1138](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1138))
- `split` accepts any number of predicates and narrows the type of each split ([#1138](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1138))
- The `ChromeRuntimeDuplexStream` constructor throws if `localTarget` and `remoteTarget` are the same, as `make()` already did ([#1138](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1138))

### Removed

- **BREAKING:** Remove the `MessagePortReader`, `MessagePortWriter`, `PostMessageReader`, `PostMessageWriter`, `ChromeRuntimeReader`, `ChromeRuntimeWriter`, `NodeWorkerReader`, and `NodeWorkerWriter` exports; use the corresponding duplex streams instead ([#1138](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1138))

### Fixed

- `PostMessageDuplexStream` calls `onEnd` once per stream, and writes after the remote side ends return a done result instead of throwing when `onEnd` closes the transport ([#1137](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1137))

## [0.6.0]

### Changed

- Bump compatible versions of sibling `@metamask/*` packages

## [0.5.0]

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))

## [0.4.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))

### Removed

- Remove `/vat` export ([#600](https://github.com/MetaMask/ocap-kernel/pull/600))

## [0.3.0]

### Added

- Add remoteable iterators and generators ([#574](https://github.com/MetaMask/ocap-kernel/pull/574))

### Changed

- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590), [#543](https://github.com/MetaMask/ocap-kernel/pull/543))
- Use `@metamask/logger` ([#559](https://github.com/MetaMask/ocap-kernel/pull/559))

## [0.2.0]

### Added

- Make export paths compatible with Browserify ([#533](https://github.com/MetaMask/ocap-kernel/pull/533))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/streams@0.6.0...HEAD
[0.6.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/streams@0.5.0...@metamask/streams@0.6.0
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/streams@0.4.0...@metamask/streams@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/streams@0.3.0...@metamask/streams@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/streams@0.2.0...@metamask/streams@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/streams@0.1.0...@metamask/streams@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/streams@0.1.0
