# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** The matcher vat ranks via the daemon's `languageModelService` kernel service instead of the external `@ocap/llm-bridge` process; ranking is stateless (each `findServices` call carries the full current registry in one chat-completion request) and registrations no longer involve the LLM ([#1215](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1215))
- **BREAKING:** `makeMatcherClusterConfig` requires a `model` option, passed to the matcher vat as its `model` parameter ([#1215](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1215))
- `start-matcher.sh` provisions the daemon's `llm.json` instead of spawning an llm-bridge process ([#1215](https://github.com/Consensys-Incorporated/ocap-kernel/pull/1215))

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/
