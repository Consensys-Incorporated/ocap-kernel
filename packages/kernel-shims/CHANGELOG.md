# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Upgrade `ses` to 2.x, so `endoify` no longer makes `Float16Array`, `Float32Array`, and `Float64Array` available in compartments the caller creates ([#1112](https://github.com/MetaMask/ocap-kernel/pull/1112))
  - They remain on the start compartment, so only compartment code is affected, and they can still be endowed explicitly — at the cost of reopening the `NaN` bit-pattern side channel SES withholds them to close
  - `lockdown()` now repairs `DataView.prototype.setFloat*` to write only canonical `NaN`s, making `DataView` the safe alternative

## [0.5.0]

### Changed

- Update libp2p webrtc peer dependency to v6 ([#900](https://github.com/MetaMask/ocap-kernel/pull/900))

## [0.4.0]

### Added

- Add `./endoify-node` export for Node.js-specific lockdown initialization ([#787](https://github.com/MetaMask/ocap-kernel/pull/787))
- Add `./endoify-repair` export for `repairIntrinsics`-only lockdown ([#578](https://github.com/MetaMask/ocap-kernel/pull/578))

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))

## [0.3.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))
- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590), [#543](https://github.com/MetaMask/ocap-kernel/pull/543))

## [0.2.0]

### Added

- Add eventual send shim ([#536](https://github.com/MetaMask/ocap-kernel/pull/536))

### Fixed

- Enable `sideEffects` in `package.json` ([#522](https://github.com/MetaMask/ocap-kernel/pull/522))
  - This indicates to bundlers and other tools that imports from this package may cause side effects, as they all do.

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-shims@0.5.0...HEAD
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-shims@0.4.0...@metamask/kernel-shims@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-shims@0.3.0...@metamask/kernel-shims@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-shims@0.2.0...@metamask/kernel-shims@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-shims@0.1.0...@metamask/kernel-shims@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-shims@0.1.0
