# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **BREAKING:** Remove the CommonJS build; the package is ESM-only. Its entry points are `.js` and `.d.ts` files, formerly `.mjs`/`.cjs` and `.d.mts`/`.d.cts` ([#1186](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1186))

## [0.7.0]

### Changed

- Bump compatible versions of sibling `@metamask/*` packages

## [0.6.0]

### Added

- Add tagless console and file transports ([#828](https://github.com/MetaMask/ocap-kernel/pull/828))

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))
- Make `Logger` obey log level settings ([#703](https://github.com/MetaMask/ocap-kernel/pull/703))

## [0.5.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))

## [0.4.0]

### Changed

- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590))

## [0.3.0]

### Added

- Support streaming falsy values ([#542](https://github.com/MetaMask/ocap-kernel/pull/542))

## [0.2.0]

### Changed

- Include JSON-RPC notifications in `KernelMessage` type ([#528](https://github.com/MetaMask/ocap-kernel/pull/528))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/logger@0.7.0...HEAD
[0.7.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/logger@0.6.0...@metamask/logger@0.7.0
[0.6.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/logger@0.5.0...@metamask/logger@0.6.0
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/logger@0.4.0...@metamask/logger@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/logger@0.3.0...@metamask/logger@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/logger@0.2.0...@metamask/logger@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/logger@0.1.0...@metamask/logger@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/logger@0.1.0
