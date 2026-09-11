# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Vend the `fs` capability as an exo taking absolute path segments, replacing the `node:fs` lookalike record of functions ([#1057](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1057))
  - Call it as `await E(fs).readFile(['srv', 'data', 'x'])`. Methods share one flat namespace, so `promises.readFile` is now `readFile`, and a segment may not be empty, `.`, `..`, or contain a path separator.
  - `existsSync` and every other synchronous operation are gone. A narrowed method forwards through `E()`, so nothing synchronous can survive narrowing.
  - Config is `{ root: ['srv', 'data'], methods: ['readFile'] }`, replacing `{ rootDir, promises: { readFile } }`. An empty `root` is rejected rather than denoting the whole filesystem, and a platform prefix is a leading segment, so a Windows drive is `['C:', 'srv']`.
  - A trailing argument must now be Passable, so `readFile(path, { signal })` is rejected where the bare `node:fs` function accepted it.

### Removed

- **BREAKING:** Remove the `fetch` platform capability and its exports (`fetchConfigStruct`, `FetchCapability`, `FetchConfig`, `makeHostCaveat`, `makeCaveatedFetch`) ([#942](https://github.com/MetaMask/ocap-kernel/pull/942))
  - `fetch` is now a vat endowment in `@metamask/ocap-kernel`; see its changelog for the migration

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-platforms@0.1.0...HEAD
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-platforms@0.1.0
