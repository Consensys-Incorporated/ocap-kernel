# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add an `http` capability, an exo whose `request(host, path, options)` takes the host's labels reversed, as in `['com', 'example', 'api']`, so `pathUnder` can narrow it to a domain ([#1163](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1163))
  - Config is `{ allow: [rule, ...] }`, admitting a request any rule admits. A rule names a `host` and optionally a `path`, each admitting what lies below it unless `exactHost` or `exactPath`, and optionally the `protocol`, the `ports` a request may name, and the `methods` it may use
  - A path segment may not be `.` or `..`, or contain `/` or `\`
  - Redirects are returned rather than followed; in a browser, which hides a redirect's target, the request fails instead
  - The capability factory takes an optional `fetch` to make requests with
  - Its types are exported as `HttpCapability`, `HttpMethods`, and `HttpOptions`
- Add `makeFetch(http)`, a `fetch` that sends each request through an `http` capability, following redirects through it too ([#1163](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1163))
  - It supports string bodies only, and answers with an empty `url`. Aborting a `signal` rejects the `fetch`, though a request already sent completes
  - A vat using it must request the `URL`, `Request`, `Headers`, and `Response` globals, and `crypto` to check an `integrity`

### Changed

- **BREAKING:** Vend the `fs` capability as an exo taking absolute path segments, replacing the `node:fs` lookalike record of functions ([#1135](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1135))

  - Call it as `await E(fs).readFile(['srv', 'data', 'x'], 'utf8')`. Methods share one flat namespace, so `promises.readFile` is now `readFile`, and a segment may not be empty, `.`, `..`, or contain a path separator.
  - `readFile` requires an encoding and resolves a string. Without one Node resolves a `Buffer`, and no typed array can cross an exo boundary, so reading raw bytes is not available.
  - `existsSync` and every other synchronous operation are gone. A narrowed method forwards through `E()`, so nothing synchronous can survive narrowing.
  - Config is `{ root: ['srv', 'data'], methods: ['readFile'] }`, replacing `{ rootDir, promises: { readFile } }`. An empty `root` is rejected rather than denoting the whole filesystem.
  - Every argument must be Passable, so an options record carrying an `AbortSignal` is rejected where the bare `node:fs` function accepted it.
  - The capability factory is now async.
  - On Node.js, a path through a symlink at any position, or differing in case from the entry it names, is rejected, so `root` must be canonical: on macOS, `/private/var/...` rather than `/var/...`.

- Enforce the `fs` config's `root` and method set with a narrowing rather than a hand-rolled caveat, so a holder that narrows the capability further composes with the configured bound instead of stacking a second mechanism on it ([#1135](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1135))

### Removed

- **BREAKING:** Remove the CommonJS build; the package is ESM-only. Its entry points are `.js` and `.d.ts` files, formerly `.mjs`/`.cjs` and `.d.mts`/`.d.cts` ([#1186](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1186))
- **BREAKING:** Remove the `fetch` platform capability and its exports (`fetchConfigStruct`, `FetchCapability`, `FetchConfig`, `makeHostCaveat`, `makeCaveatedFetch`), in favour of `http` ([#942](https://github.com/MetaMask/ocap-kernel/pull/942), [#1163](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1163))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/kernel-platforms@0.1.0...HEAD
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/kernel-platforms@0.1.0
