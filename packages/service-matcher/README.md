# `@ocap/service-matcher`

Ocap kernel vat implementing the service matcher from
`@metamask/service-discovery-types`.

## Running the matcher

The matcher relies on a libp2p relay to be reachable by providers and
consumers. The relay is started separately (typically via `yarn ocap
relay`); `start-matcher.sh` does not depend on it and can be run in
either order, picking up the relay's multiaddr via `--relay`,
`$OCAP_RELAY_MULTIADDR`, or `$HOME/.libp2p-relay/relay.addr`.

The matcher ranks services with the `languageModelService` kernel
service, which the daemon registers at startup from `llm.json` in its
OCAP home. `start-matcher.sh` writes that config to point at an
openclaw gateway and requires `OPENCLAW_GATEWAY_TOKEN` in its
environment (`OPENCLAW_GATEWAY_URL` and `OPENCLAW_AGENT_MODEL` are
optional overrides).

```bash
# Start the relay in one terminal (writes ~/.libp2p-relay/relay.addr on success):
yarn ocap relay

# Start the matcher in another. It prints its OCAP URL on stdout:
export OPENCLAW_GATEWAY_TOKEN=<gateway.auth.token>
MATCHER_OCAP_URL=$(./packages/service-matcher/scripts/start-matcher.sh)
echo "Matcher URL: $MATCHER_OCAP_URL"
```

See `scripts/start-matcher.sh --help` for options.

## Contributing

This package is part of a monorepo. Instructions for contributing can be found in the [monorepo README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
