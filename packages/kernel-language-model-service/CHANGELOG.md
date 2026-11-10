# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release as a published package (previously the private `@ocap/kernel-language-model-service`) ([#1215](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1215))

### Security

- `makeHostRestrictedFetch` can no longer reach a host outside `allowedHosts`. The host was checked against one resolution of the input while `fetch` resolved it again (CWE-367), and a redirect out of the allowlist was followed unchecked ([#1026](https://github.com/MetaMask/ocap-kernel/pull/1026))
  - `redirect: 'follow'` no longer reaches the hop unchecked, so the `baseFetch` argument is always called with `redirect: 'manual'` and must honour it. A `dispatcher` in `init` is rejected, and a redirect that keeps a body that cannot be sent again now fails

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/
