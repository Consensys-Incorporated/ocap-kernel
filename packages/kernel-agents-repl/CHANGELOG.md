# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The REPL no longer loads `ses` itself; it uses the `Compartment` global of the realm that ran lockdown, so it can be bundled into a vat ([#1255](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1255))

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/
