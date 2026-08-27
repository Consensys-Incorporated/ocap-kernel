# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Log a fatal message when the kernel's run loop dies, since the worker outlives the kernel and has no exit to take ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))

### Fixed

- The kernel worker gives the kernel store a logger, so the wasm SQLite driver's diagnostics reach the log rather than nowhere ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
- Process platform-services RPC request handlers in the background so a request handler that fires a reentrant outbound RPC (e.g. transport handshake calling back into the kernel) cannot deadlock waiting for its response ([#948](https://github.com/MetaMask/ocap-kernel/pull/948))

## [0.6.0]

### Added

- Pass full `RemoteCommsOptions` via worker URL ([#881](https://github.com/MetaMask/ocap-kernel/pull/881), [#906](https://github.com/MetaMask/ocap-kernel/pull/906), [#915](https://github.com/MetaMask/ocap-kernel/pull/915))

## [0.5.0]

### Added

- Add console forwarding utilities (`setupConsoleForwarding`, `handleConsoleForwardMessage`, `isConsoleForwardMessage`) ([#798](https://github.com/MetaMask/ocap-kernel/pull/798))
- Add caplet vat support to kernel facade and subcluster launching ([#753](https://github.com/MetaMask/ocap-kernel/pull/753))
- Add CapTP infrastructure (`background-captp`, `kernel-captp`, `kernel-facade`) ([#751](https://github.com/MetaMask/ocap-kernel/pull/751))
  - Add system subclusters support and kernel facet service via CapTP ([#803](https://github.com/MetaMask/ocap-kernel/pull/803))
  - Add RPC handler modules and export `ocapUrl*` methods for offline use ([#823](https://github.com/MetaMask/ocap-kernel/pull/823))
- Add relay query string utilities and relay-based kernel worker initialization ([#638](https://github.com/MetaMask/ocap-kernel/pull/638))
  - Add `resetStorage` query parameter support and remove `createWorkerUrlWithRelays` export ([#642](https://github.com/MetaMask/ocap-kernel/pull/642))
- Add `PlatformServicesClient` and `PlatformServicesServer` for kernel-to-kernel network comms ([#578](https://github.com/MetaMask/ocap-kernel/pull/578))
  - Add location hints parameter to `sendRemoteMessage` in `PlatformServicesClient` and `PlatformServicesServer` ([#666](https://github.com/MetaMask/ocap-kernel/pull/666))
  - Add automatic reconnection with exponential backoff to `PlatformServicesClient` and `PlatformServicesServer` ([#678](https://github.com/MetaMask/ocap-kernel/pull/678))
  - Change `PlatformServicesServer` to no-op instead of throwing when stopping uninitialized remote comms ([#692](https://github.com/MetaMask/ocap-kernel/pull/692))
  - Add explicit connection management (`closeConnection`) to `PlatformServicesClient` and `PlatformServicesServer` ([#699](https://github.com/MetaMask/ocap-kernel/pull/699))
  - Reject promises on connection loss in `PlatformServicesClient` and `PlatformServicesServer` ([#706](https://github.com/MetaMask/ocap-kernel/pull/706))
  - Refactor remote location hint handling in `PlatformServicesClient` and `PlatformServicesServer` ([#712](https://github.com/MetaMask/ocap-kernel/pull/712))
  - Add message sequencing and acknowledgment to `PlatformServicesClient` and `PlatformServicesServer` ([#744](https://github.com/MetaMask/ocap-kernel/pull/744))
  - Rename `initNetwork` to `initTransport` in `PlatformServicesServer` ([#749](https://github.com/MetaMask/ocap-kernel/pull/749))
  - Add kernel incarnation detection to `PlatformServicesClient` and `PlatformServicesServer` ([#788](https://github.com/MetaMask/ocap-kernel/pull/788))
  - Handle reconnection to restarted peers with incarnation ID detection ([#807](https://github.com/MetaMask/ocap-kernel/pull/807))
  - Update `PlatformServicesClient` and `PlatformServicesServer` for ken protocol ([#811](https://github.com/MetaMask/ocap-kernel/pull/811))
  - Add cross-incarnation wake detection to `PlatformServicesClient` and `PlatformServicesServer` ([#822](https://github.com/MetaMask/ocap-kernel/pull/822))
  - Add `getListenAddresses()` method to `PlatformServicesClient` (returns empty array in browser) ([#839](https://github.com/MetaMask/ocap-kernel/pull/839))

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))
- **BREAKING:** Remove `./default-cluster` export ([#834](https://github.com/MetaMask/ocap-kernel/pull/834))
- Simplify kernel worker initialization ([#718](https://github.com/MetaMask/ocap-kernel/pull/718))
- Move default cluster startup to background and add internal comms infrastructure ([#709](https://github.com/MetaMask/ocap-kernel/pull/709))
- Migrate to `JsonRpcEngine` v2 for kernel worker middleware ([#707](https://github.com/MetaMask/ocap-kernel/pull/707))
- Bump `@metamask/snaps-utils` from `^9.1.0` to `^11.6.1` ([#682](https://github.com/MetaMask/ocap-kernel/pull/682))

### Fixed

- Fix persistence handling in `VatWorkerClient` and `VatWorkerServer` ([#604](https://github.com/MetaMask/ocap-kernel/pull/604))

## [0.4.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))

## [0.3.0]

### Changed

- Use the MetaMask design system ([#577](https://github.com/MetaMask/ocap-kernel/pull/577))
- Wait for crank to run kernel actions ([#595](https://github.com/MetaMask/ocap-kernel/pull/595))
- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590))

### Fixed

- Restore `kernel-browser-runtime` sourcemaps in extension ([#575](https://github.com/MetaMask/ocap-kernel/pull/575))

## [0.2.0]

### Added

- Add `revoke` kernel command ([#544](https://github.com/MetaMask/ocap-kernel/pull/544))
- Support multiple subclusters ([#530](https://github.com/MetaMask/ocap-kernel/pull/530))

### Removed

- Remove support for launching vats outside a subcluster ([#535](https://github.com/MetaMask/ocap-kernel/pull/535))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-browser-runtime@0.6.0...HEAD
[0.6.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-browser-runtime@0.5.0...@metamask/kernel-browser-runtime@0.6.0
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-browser-runtime@0.4.0...@metamask/kernel-browser-runtime@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-browser-runtime@0.3.0...@metamask/kernel-browser-runtime@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-browser-runtime@0.2.0...@metamask/kernel-browser-runtime@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-browser-runtime@0.1.0...@metamask/kernel-browser-runtime@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-browser-runtime@0.1.0
