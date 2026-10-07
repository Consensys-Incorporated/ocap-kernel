# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add global `--home <dir>` flag overriding `$OCAP_HOME` for the duration of one invocation, so multiple OCAP daemons can run side by side without juggling environment variables ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))
- Add `--public-ip <addr>` to `kernel relay start` (also reads `$LIBP2P_RELAY_PUBLIC_IP`); the relay announces the supplied IPv4 alongside its bound NIC addresses, so a NAT-backed VPS can be reached from off-host peers ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))
- More legible output from `kernel relay status` ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))

### Changed

- **BREAKING:** `daemon start`, `daemon exec`, `daemon redeem-url`, and `daemon queueMessage` fail on Windows
- **BREAKING:** `executeDBQuery`, `clearState`, and `terminateAllVats` are no longer served on the daemon control socket unless the daemon is started with `OCAP_DEV_MODE=true` ([#1034](https://github.com/MetaMask/ocap-kernel/pull/1034))
  - `executeDBQuery` runs caller-supplied SQL against kernel state; it has no place in a deployed configuration. In default mode its handler is not registered at all, rather than being refused by name.
  - The refusal names the flag, so a caller who hits it is told which daemon to restart and how.
- `$OCAP_HOME` is created `0700` and the daemon socket `0600`, instead of inheriting the ambient umask. The directory mode is reapplied on every start, so an `$OCAP_HOME` created before this change is brought forward rather than keeping its old permissions ([#1034](https://github.com/MetaMask/ocap-kernel/pull/1034))
- The daemon log filters entries below a minimum severity, defaulting to `info`, so high-volume `debug` output (refcount churn and similar) no longer dominates `daemon.log`; set `$OCAP_DAEMON_LOG_LEVEL` to `debug` to record everything again ([#1008](https://github.com/MetaMask/ocap-kernel/pull/1008))
- Relay state files (`relay.pid`, `relay.addr`) now live in their own directory (default `~/.libp2p-relay`, overridable via `$LIBP2P_RELAY_HOME`) instead of under `$OCAP_HOME`, so one libp2p relay can serve daemons with different OCAP_HOMEs ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))

### Fixed

- `kernel daemon start` refuses to start when another daemon is already listening on the same Unix socket, instead of unlinking the socket and orphaning the running process ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))
- Daemon fatal-path visibility: `daemon-entry` now installs handlers for `uncaughtException`, `unhandledRejection`, `SIGHUP`, and `exit` that append a synchronous fingerprint line to `daemon.log` before terminating ([#966](https://github.com/MetaMask/ocap-kernel/pull/966))
  - Without these, silent daemon deaths under `stdio: 'ignore'` (the CLI's default spawn mode) left no trace in the log; the operator saw only that the daemon was gone. Every terminating path now leaves at least one line.
- The daemon logs the failure and shuts down with a non-zero exit code when the kernel's run loop dies, instead of staying up with a socket that answers RPCs for a kernel that processes nothing ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - A death during startup aborts `daemon start` instead of publishing a socket and pid file for a dead kernel
  - Shutdown is bounded at 10 seconds and terminates the process either way, removing the pid file first. Live vat worker threads hold the event loop open, so an exit code alone never took effect, leaving an orphan on `kernel.sqlite` that neither start-time interlock could see
  - Failures carry their `cause` chain, so a death reported through a failed crank rollback still names the error that killed the kernel
  - Logging in front of a shutdown or `process.exit` is best-effort, the fatal handlers included: the transport is `appendFileSync`, so a full disk would otherwise take the termination with it

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-cli@0.1.0...HEAD
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-cli@0.1.0
