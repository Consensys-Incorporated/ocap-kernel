# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `narrowInterfaceGuard` and the `NarrowingDelta` type, which derive the interface guard of a narrowing: each delta pattern is conjoined onto the base's guard at the argument position it addresses, arity and return guards are inherited verbatim, methods the delta does not name are dropped, and every method guard is asyncified for forwarding ([#1051](https://github.com/MetaMask/ocap-kernel/pull/1051))
- Add `pathUnder(segments)`, which builds an `@endo/patterns` pattern matching segment arrays under a prefix, with `..` excluded past the prefix so that traversal out of it is unrepresentable. Empty `segments` matches every `..`-free segment array ([#1049](https://github.com/MetaMask/ocap-kernel/pull/1049))
- Add `narrow({ name, base, delta })`, which reads the base's interface guard over `E()` and returns an exo under the derived guard whose methods forward to the base. Narrowing a narrowing flattens: the result forwards straight to the original base under both deltas conjoined, so a chain of any depth stays one hop deep and costs one guard read. Every method of the result returns a promise ([#1052](https://github.com/MetaMask/ocap-kernel/pull/1052))
- Add `join({ name, refs })`, which returns a narrowing of its refs' common base admitting whatever any of them admits: the result's methods are the union of the operands', and where two operands name the same method each argument position is disjoined. Every ref must be one `narrow` minted from that base, or the base itself, which admits everything and so absorbs. A ref minted from some other base, or by nothing at all, throws ([#1053](https://github.com/MetaMask/ocap-kernel/pull/1053))
- Add the `NarrowingDelta`, `NarrowOptions`, and `JoinOptions` types ([#1049](https://github.com/MetaMask/ocap-kernel/pull/1049))
- Add `getInterfaceMethodGuards`, `getMethodPayload`, `getGuardAt`, `buildMethodGuard`, and `asyncifyMethodGuards`, plus the `MethodGuardPayload` type, for reading an `@endo/patterns` interface guard by argument position — required arguments, then optionals, then the rest guard — and reassembling it ([#1048](https://github.com/MetaMask/ocap-kernel/pull/1048))
- Add `makeGuardedFetch` and the `FetchGuard` type, which wrap a `fetch` so that a guard runs before every request it makes, redirect hops included ([#1026](https://github.com/MetaMask/ocap-kernel/pull/1026))
  - `redirect: 'follow'`, in the caller's `init` or on a `Request`, is overridden so that each hop can be checked; `manual` and `error` are honoured. `baseFetch` is therefore always called with `redirect: 'manual'` and must honour it
  - A `dispatcher` in `init` is rejected, and a redirect that keeps the request body fails when that body cannot be sent again — which includes any `Request` carrying one
  - An `integrity`, from `init` or from a `Request`, is withheld from `baseFetch` and checked here against the body the chain ends on. `fetch` would compare it to each hop, so no chain longer than one request could match it. Metadata naming no hash algorithm subresource integrity is defined over is refused rather than ignored as `fetch` ignores it
  - Where a runtime answers a manual redirect opaquely instead of with the real response, as browsers do, a redirect fails rather than being followed: the hop cannot be checked
- Add `resolveFetchInput` and the `FetchInput`/`ResolvedFetchInput` types, which resolve a `fetch` input to the URL that will actually be requested and return a stand-in to forward in its place, so the URL checked and the URL requested cannot disagree ([#1026](https://github.com/MetaMask/ocap-kernel/pull/1026))
- Add an `interface` variant to `JsonSchema` — `{ type: 'interface', description?, methods }` — describing an object whose methods can be invoked, so a method that returns an object reference can declare that object's API inline and a client need not make a second round-trip to discover it. The `methods` field is recursive, so a returned interface can itself return interfaces. The variant describes an _interface_; whether the reference to the object is unforgeable is a property of the reference plumbing, not of the description ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
- Add a `./described` export with a combinator namespace `S` (`S.string`/`S.number`/`S.boolean`/`S.arrayOf`/`S.record`/`S.object`/`S.nothing` leaves, plus `S.arg`/`S.method`/`S.interface`) that authors an `@endo/patterns` interface guard and a matching `MethodSchema` from a single source, so a discoverable exo's enforced shape and its `__getDescription__` hint cannot drift ([#958](https://github.com/MetaMask/ocap-kernel/pull/958))
- Add an optional `required` field to `MethodSchema` (mirroring `required` on object `JsonSchema`) naming which arguments are required, and a `{ required }` option on `methodArgsToStruct` that validates unlisted arguments as optional, so a method's argument schema can faithfully represent the optional trailing arguments its guard already allows ([#958](https://github.com/MetaMask/ocap-kernel/pull/958))
- Add `getLibp2pRelayHome()` to the `./nodejs` exports, returning the libp2p relay's bookkeeping directory (default `~/.libp2p-relay`, overridable via `$LIBP2P_RELAY_HOME`) — kept separate from `$OCAP_HOME` so one relay can serve daemons with different OCAP_HOMEs ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))
- `startRelay()` accepts an optional `publicIp` that is fed to libp2p's `appendAnnounce`, so a relay running on a NAT-backed host can announce its publicly-reachable IPv4 alongside its bound NIC addresses ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))
- Add `replaceNodeEnvPlugin` to the `./vite-plugins` exports, a Rolldown transform plugin that inlines `process.env.NODE_ENV` as a string literal (configurable via `{ value }`, defaulting to `'production'`) in any module referencing it — used by `bundleVat` in place of a build-config `define`, so vats that pull in libraries like immer resolve the reference at bundle time ([#967](https://github.com/MetaMask/ocap-kernel/pull/967))

## [0.5.0]

### Added

- Add `./vite-plugins` export with `bundleVat` and `bundleVats` vat bundling utilities (moved from `@ocap/repo-tools`) ([#875](https://github.com/MetaMask/ocap-kernel/pull/875))
- Add `vite` as an optional peer dependency for the `./vite-plugins` subpath ([#875](https://github.com/MetaMask/ocap-kernel/pull/875))
- Add `CapDataStruct` export ([#917](https://github.com/MetaMask/ocap-kernel/pull/917))
- Add JSON Schema to superstruct utilities ([#876](https://github.com/MetaMask/ocap-kernel/pull/876))
- Add `@metamask/kernel-cli` utilities ([#896](https://github.com/MetaMask/ocap-kernel/pull/896))
  - `getOcapHome()` for obtaining the CLI config dir
  - `prettifySmallcaps()` for formatting smallcaps values for display
- Add `isCapData()` utility ([#879](https://github.com/MetaMask/ocap-kernel/pull/879))

### Changed

- **BREAKING:** Rename discoverable exo `describe()` method to `__getDescription__()` ([#869](https://github.com/MetaMask/ocap-kernel/pull/869))

## [0.4.0]

### Added

- Add vat bundle utilities ([#763](https://github.com/MetaMask/ocap-kernel/pull/763))
- Add `./libp2p` export with `startRelay()` and `ifDefined()` utility ([#843](https://github.com/MetaMask/ocap-kernel/pull/843))
- Add `Promisified<T>` utility type ([#752](https://github.com/MetaMask/ocap-kernel/pull/752))
- Add `makeDiscoverableExo()` constructor ([#705](https://github.com/MetaMask/ocap-kernel/pull/705))
- Add retry utilities with exponential backoff and wake detection ([#678](https://github.com/MetaMask/ocap-kernel/pull/678))
- Add `mergeDisjointRecords()` utility ([#619](https://github.com/MetaMask/ocap-kernel/pull/619))
- Add `makeDefaultExo` utility ([#612](https://github.com/MetaMask/ocap-kernel/pull/612))
- Add hex encoding utilities ([#578](https://github.com/MetaMask/ocap-kernel/pull/578))

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))

## [0.3.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))

## [0.2.0]

### Changed

- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590), [#543](https://github.com/MetaMask/ocap-kernel/pull/543))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-utils@0.5.0...HEAD
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-utils@0.4.0...@metamask/kernel-utils@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-utils@0.3.0...@metamask/kernel-utils@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-utils@0.2.0...@metamask/kernel-utils@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-utils@0.1.0...@metamask/kernel-utils@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-utils@0.1.0
