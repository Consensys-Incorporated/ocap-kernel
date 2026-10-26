# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `RpcClient` result-validation errors now include the individual struct failures, not just the top-level message ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - A union's own message names only the union, so a reply from a peer built against an older schema was indistinguishable from an ordinary bad value; the failures name the branch and the key

### Removed

- **BREAKING:** Remove the CommonJS build; the package is ESM-only. Its entry points are `.js` and `.d.ts` files, formerly `.mjs`/`.cjs` and `.d.mts`/`.d.cts` ([#1186](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1186))

## [0.6.0]

### Changed

- Bump compatible versions of sibling `@metamask/*` packages

## [0.5.0]

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))

## [0.4.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))

## [0.3.0]

### Changed

- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590))

## [0.2.0]

### Changed

- Support `Promise<void>` in addition to `void` for result types ([#528](https://github.com/MetaMask/ocap-kernel/pull/528))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-rpc-methods@0.6.0...HEAD
[0.6.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-rpc-methods@0.5.0...@metamask/kernel-rpc-methods@0.6.0
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-rpc-methods@0.4.0...@metamask/kernel-rpc-methods@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-rpc-methods@0.3.0...@metamask/kernel-rpc-methods@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-rpc-methods@0.2.0...@metamask/kernel-rpc-methods@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-rpc-methods@0.1.0...@metamask/kernel-rpc-methods@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-rpc-methods@0.1.0
