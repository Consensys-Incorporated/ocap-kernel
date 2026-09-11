# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Make the `fs` capability promises-only ([#1055](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1055))
  - `existsSync` and its config flag are gone, along with every other synchronous operation. A narrowed method forwards through `E()`, so nothing synchronous can survive narrowing.

### Removed

- **BREAKING:** Remove the `fetch` platform capability and its exports (`fetchConfigStruct`, `FetchCapability`, `FetchConfig`, `makeHostCaveat`, `makeCaveatedFetch`) ([#942](https://github.com/MetaMask/ocap-kernel/pull/942))
  - `fetch` is now a vat endowment in `@metamask/ocap-kernel`; see its changelog for the migration

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-platforms@0.1.0...HEAD
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-platforms@0.1.0
