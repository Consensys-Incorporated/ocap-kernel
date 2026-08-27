# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `onRunLoopFailure` to `makeKernel`, forwarded to `Kernel.make` and called with the error that killed the kernel's run loop ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))

### Changed

- **BREAKING:** `startRpcSocketServer` and `startDaemon` no longer serve `executeDBQuery`, `clearState`, or `terminateAllVats` by default; pass `devMode: true` to restore them ([#1034](https://github.com/MetaMask/ocap-kernel/pull/1034))
  - In default mode the handlers are withheld rather than merely refused by name, so the `executeDBQuery` hook is never constructed and no handler can reach `kernelDatabase.executeQuery`. The exported `DEV_ONLY_METHODS` names the withheld set.
  - This is not a security boundary on its own: `launchSubcluster` and `queueMessage` remain reachable and either suffices to drive the kernel arbitrarily. Anyone able to open the socket controls the kernel — see the trust model in `@metamask/kernel-cli`'s README.
- The RPC socket is created `0600`. The bind runs under a `0o177` umask, except when the server is started off the main thread (`process.umask` throws on a worker thread), so the socket is not briefly reachable by other local users between bind and `chmod`; a `chmod` that fails closes the server rather than leaving it listening on a socket whose mode is unknown ([#1034](https://github.com/MetaMask/ocap-kernel/pull/1034))
- **BREAKING:** `makeIOChannelFactory` is now `makeIOListenerFactory`, and `makeSocketIOChannel` is now `makeSocketIOListener`. The Unix-socket server hands each connection to `accept()` as its own `IOChannel`, whose receive buffer, decoder, line queue, and reader queue are local to that connection, so any number of peers can be served concurrently. Connections arriving before `accept()` is called are queued rather than dropped. Gone with the single-client design: the shared `currentSocket`, the session-boundary latch, the merged line queue, and the `socket.destroy()` that rejected every second connection ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
- **BREAKING:** Drop `platformOptions.fetch` from `makeNodeJsVatSupervisor` ([#942](https://github.com/MetaMask/ocap-kernel/pull/942))
  - `fetch` is now a vat endowment; stub `globalThis.fetch` directly if needed

### Fixed

- `makeKernel` gives the kernel store a logger, so the SQLite driver's diagnostics reach the log rather than nowhere ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
- The RPC socket server refuses to bind a Unix socket that has a live listener, rather than unlinking it and orphaning the previous owner; stale socket files with no listener are still cleaned up automatically ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-node-runtime@0.1.0...HEAD
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-node-runtime@0.1.0
