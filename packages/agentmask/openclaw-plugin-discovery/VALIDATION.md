# Phase 3 validation — `@openclaw/discovery`

This document walks through end-to-end validation of the discovery
plugin against a running Phase 1 provider (MetaMask extension) and a
Phase 2 matcher (daemon on VPS). The deployment is split across two
hosts: matcher infrastructure on a VPS, and the MetaMask extension
plus its sample-services daemon on the laptop.

## Topology

```
                          VPS
┌─────────────────────────────────────────────────────┐
│  relay (libp2p) — writes ~/.libp2p-relay/relay.addr │
│                                                     │
│  matcher daemon   — OCAP_HOME=~/.ocap (default)     │
│    (subcluster running the matcher vat,             │
│     plus the llm-bridge process)                    │
│                                                     │
│  consumer daemon  — OCAP_HOME=~/.ocap-consumer      │
│    (no subclusters; hosts the openclaw plugin's     │
│     RPC target)                                     │
│                                                     │
│  openclaw + @openclaw/discovery                     │
│    (drives the consumer daemon via RPC)             │
└─────────────────────────────────────────────────────┘
                           │ relay hints
                           ▼
                         Laptop
┌─────────────────────────────────────────────────────┐
│  MetaMask extension                                 │
│    with the PersonalMessageSigner provider vat,     │
│    registered against the matcher                   │
│                                                     │
│  sample-services daemon — OCAP_HOME=~/.ocap-services│
│    (one subcluster per non-MetaMask service:        │
│     Echo, RandomNumber)                             │
└─────────────────────────────────────────────────────┘
```

The VPS hosts the matcher and consumer daemons in separate home
directories so they don't clobber each other's state: the matcher uses
the default `~/.ocap`, the consumer uses `~/.ocap-consumer`. Every
`ocap` invocation that wants a non-default daemon passes
`--home <dir>`; invocations without `--home` hit the matcher. The
sample-services daemon lives on the laptop alongside the MetaMask
extension and uses `~/.ocap-services`. All daemons (and the
browser-side PMS provider) talk to each other over the relay.

## Prerequisites

Four things must be live before starting this validation:

1.  **Relay** on the VPS (`yarn ocap relay`; writes
    `~/.libp2p-relay/relay.addr`). Leave it running. The relay
    keeps its bookkeeping (`relay.pid`, `relay.addr`) under
    `~/.libp2p-relay` rather than `~/.ocap` so the same relay
    can serve daemons running under arbitrary `OCAP_HOME` values
    (override with `LIBP2P_RELAY_HOME` if you need a non-default
    location).

    On a VPS where the public IP isn't bound to a local NIC (most
    NAT-backed cloud setups), libp2p won't auto-detect it, so the
    multiaddr written into `relay.addr` would only contain a loopback
    or RFC 1918 address — not reachable from the browser running the
    provider extension. Pass the public address explicitly:

    ```bash
    yarn ocap relay --public-ip 164.92.86.40   # or
    LIBP2P_RELAY_PUBLIC_IP=164.92.86.40 yarn ocap relay
    ```

    The relay then announces that address alongside the auto-detected
    ones, and the relay-addr picker prefers a public-looking IPv4 over
    private/loopback. Set the env var in your shell profile so you
    don't have to remember it on each restart.

2.  **Matcher daemon** on the VPS, started via
    `packages/service-matcher/scripts/start-matcher.sh`. The script
    prints the matcher OCAP URL on stdout — copy it. See the
    [Restarting](#restarting) section below for what this command
    actually does and when you should use a different one.

    The matcher ranks via an LLM through `@ocap/llm-bridge`, which
    talks to the openclaw gateway's OpenAI-compatible
    `/v1/chat/completions` endpoint. That adds two requirements,
    described in the next two subsections.

3.  **Sample-services daemon** on the laptop (the same machine as the
    MetaMask extension), started via
    `packages/sample-services/scripts/start-services.sh <matcher-url>`
    (or with `MATCHER_OCAP_URL` exported in the shell). It launches
    one subcluster per service: Echo and RandomNumber. Each
    subcluster's bootstrap registers with the matcher using the URL
    threaded through its vat parameters, so the matcher daemon log on
    the VPS should grow two `[matcher] registered svc:N:` lines once
    this starts.

    For the laptop-side reset-and-restart cycle (stop services, clear
    log, re-launch pointed at the current matcher URL), use
    `packages/sample-services/scripts/reset-services.sh <matcher-url>`.

4.  **Provider extension** — MetaMask loaded in a browser with the
    matcher URL baked in via `.metamaskrc`
    (`MATCHER_OCAP_URL=…`), webpack rebuilt, extension reloaded. The
    offscreen console should show one PersonalMessageSigner
    registration-success line; combined with the two registrations
    from sample-services above, the matcher daemon log should show
    three `[matcher] registered svc:N:` lines total.

### Openclaw gateway config

Openclaw stores its config in `~/.openclaw/openclaw.json`; settings
can be edited either via that JSON directly or via
`openclaw config set <dotted-path> <value>` (which just rewrites the
same file). The keys we need to confirm or set:

```bash
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
openclaw config get gateway.auth.mode    # should be "token"
openclaw config get gateway.auth.token   # an existing secret string
openclaw gateway restart
```

Most setups already have `gateway.auth.mode` set to `"token"` and a
`gateway.auth.token` populated by the openclaw install / consumer-LLM
setup that came before this work. **Don't mint a new token if one
already exists** — copy the existing value and reuse it; clobbering
the token would invalidate any other clients pointed at the gateway.
Only the `chatCompletions` endpoint flag is reliably new.

### Bridge env vars

In the shell that runs `start-matcher.sh` (set these in your shell
profile alongside `LIBP2P_RELAY_PUBLIC_IP`):

```bash
export OPENCLAW_GATEWAY_TOKEN=<the existing gateway.auth.token value>
# Optional overrides:
# export OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789  # default
# export OPENCLAW_AGENT_MODEL=openclaw                # default
```

The bridge runs as a background process beside the matcher daemon
(pid file at `~/.ocap/matcher-llm-bridge.pid`, log at
`~/.ocap/matcher-llm-bridge.log`). `start-matcher.sh` reaps any
previous bridge before spawning a new one; `reset-everything.sh`
tears it down alongside the daemons.

The bridge log captures both halves of every round trip so you can
see exactly what's flowing to and from the LLM. Each ingest or
query produces:

```text
[llm-bridge] -> ingest: {full request JSON}
[llm-bridge] → chat-completions request: {full messages array sent to openclaw}
[llm-bridge] ← chat-completions reply: {full response body from openclaw}
[llm-bridge] <- ingested (svc:0)
```

`tail -f ~/.ocap/matcher-llm-bridge.log` while you exercise the
matcher to watch prompts and replies in real time.

## Restarting

There are two kinds of restart, and they have very different
consequences for the matcher OCAP URL and for the registered
services. Pick the one that matches your situation.

### Cold start — fresh URL, clean slate

Use this when:

- You're starting from zero on a new machine.
- You have changes to the **matcher vat code** itself, and you don't
  want to bother with vat upgrade (see below). A plain daemon restart
  re-uses the bundle that was registered at `launchSubcluster` time,
  so without an explicit upgrade step the new bundle won't take
  effect.
- You want to throw everything out and start fresh.

```bash
./packages/service-matcher/scripts/start-matcher.sh
```

By default this **purges existing daemon state**, starts the daemon,
initializes remote comms, builds and bundles the matcher vat, and
launches a fresh matcher subcluster. The OCAP URL on stdout will be
new. Each provider must be reconfigured: update `.metamaskrc` with
the new URL, rebuild webpack, reload the extension.

### Pick up new software without losing the URL

Use this when:

- You've changed code **outside the matcher vat bundle** (the relay,
  the kernel CLI, kernel-utils, etc.) and want the matcher to keep
  its existing OCAP URL across the restart.
- You're not changing the matcher vat itself.

```bash
# Stop the matcher daemon, leaving its state intact.
yarn ocap daemon stop

# Pull / rebuild the packages whose code actually changed, e.g.:
yarn workspace @metamask/kernel-utils build
yarn workspace @metamask/kernel-cli build

# Restart, reusing existing state and reconnecting to the relay.
yarn ocap daemon start --local-relay
```

The previously-launched matcher subcluster auto-revives, the matcher
vat re-incarnates, and the durable `publicFacet` kref is restored,
so the OCAP URL is unchanged. The provider does **not** need a new
URL in `.metamaskrc`.

**Caveat — registry is in-memory.** The matcher's service registry
lives in vat closure state, not baggage, so it is empty after
re-incarnation. Each provider needs to call `registerServiceByRef`
again. With the MetaMask extension that means a page reload (no
webpack rebuild needed); registration happens at vat bootstrap. The
matcher daemon log should show fresh `[matcher] registered svc:N:`
lines.

If the matcher vat code itself changed (e.g., today's fix to the
durable-kind calling convention), a plain daemon restart will keep
running the **old** bundle that was originally registered with the
subcluster — re-incarnation alone does not pick up new source.

In principle, swingset's durable-kind machinery supports a vat
**upgrade**: the bundle can be replaced while the durable kref and
all durable-kind instances retain their identity, provided the
shapes of the persisted state are still compatible. (Preserving
identity across an implementation change was a primary motivation
for the exo abstraction in the first place.) The ocap-kernel CLI
does not currently expose an upgrade command for matcher vats, so
in practice cold start is what's available today; this is a likely
future tooling improvement and a strictly better choice than cold
start whenever the persisted state shape is unchanged.

## Stage A — Install the discovery plugin

### A.1. Start the consumer daemon under its own home

The matcher daemon is already running under the default
`~/.ocap`. Start the consumer daemon under `~/.ocap-consumer`,
passing `--local-relay` so daemon start also reads the relay address
out of `~/.libp2p-relay/relay.addr` and runs `initRemoteComms` for you:

```bash
mkdir -p ~/.ocap-consumer
yarn ocap --home ~/.ocap-consumer daemon start --local-relay
```

Every subsequent `yarn ocap` invocation that wants to talk to the
consumer daemon must include `--home ~/.ocap-consumer`. Without it,
`yarn ocap` defaults to `~/.ocap` and addresses the matcher daemon
instead.

Confirm `getStatus` shows `remoteComms.state === "connected"`:

```bash
yarn ocap --home ~/.ocap-consumer daemon exec getStatus
```

### A.2. Install and enable the plugin

```bash
cd ~/GitRepos/ocap-kernel
openclaw plugins install -l ./packages/agentmask/openclaw-plugin-discovery
openclaw plugins enable discovery
openclaw config set plugins.allow '["discovery"]'
# tools.allow matches tool names, not plugin ids: list each tool the
# plugin exposes. (`openclaw config unset tools.allow` to allow all
# tools is also fine for development.)
openclaw config set tools.allow '["discovery_redeem_matcher","discovery_find_services","service_get_description","service_initiate_contact","service_call","discovery_list_tracked"]'
```

`tools.profile` filters tool visibility _independently_ of `tools.allow`.
The default `coding` profile excludes the discovery tools entirely, so
the LLM sees zero discovery surface even with `tools.allow` correctly
populated. Drop the profile (or pick one that includes plugin tools):

```bash
openclaw config unset tools.profile
openclaw config get tools     # confirm: no "profile" field
```

For this validation, also disable the older metamask plugin if it was
previously installed — its SKILL.md primes the agent toward
wallet-specific behavior and competes with discovery:

```bash
openclaw plugins disable metamask
```

After any of the above changes, restart the openclaw gateway service
(`openclaw config set` prompts for this).

### A.3. Point the plugin at the consumer daemon + matcher URL

Use plugin config so the settings are durable across shells (no env
juggling required):

```bash
openclaw config set 'plugins.entries.discovery.config.ocapHome' "$HOME/.ocap-consumer"
openclaw config set 'plugins.entries.discovery.config.ocapCliPath' '/abs/path/to/ocap-kernel/packages/kernel-cli/dist/app.js'
openclaw config set 'plugins.entries.discovery.config.matcherUrl' 'ocap:…'
```

(The path is `plugins.entries.<plugin-id>.config.<key>` — the
`plugins.discovery.<key>` shorthand does not exist in the openclaw
config schema.)

`ocapHome` is what makes the plugin pass `--home ~/.ocap-consumer` on
every spawned `ocap` invocation, so it talks to the consumer daemon
rather than the matcher's default-home daemon.

If `matcherUrl` is supplied, the plugin redeems it eagerly at
register-time. Otherwise the first action is
`discovery_redeem_matcher`.

## Stage B — Tool-level shakedown

Drive this from `openclaw tui` (or via the CLI if you prefer). The
agent's conversation is the script; the listed tool calls are what
the agent should end up making. Paste the matcher OCAP URL in
response to the agent's first question if `matcherUrl` was not
pre-configured.

> **TUI tips, learned the hard way:**
>
> - To clear conversation context inside the running TUI, the slash
>   command is `/reset`. (`/clear` and `/new` are not recognized.)
>   Conversation history persists across `tui` restarts; if you want a
>   genuinely clean state, `/reset` is the easiest path.
> - As a sanity check before continuing, ask the agent (in plain
>   prose, not markdown): without taking any action, list every tool
>   whose name starts with the prefix discovery underscore or service
>   underscore. It should list all six. If it lists fewer or none,
>   revisit `tools.allow` and `tools.profile` in stage A.2.

1. **Connect to matcher.**

   _You:_ "Connect to the service matcher at `<matcher URL>`."

   Expected tool: `discovery_redeem_matcher(url: "ocap:…")`.
   Expected response: `Matcher kref: koN`. (Skip this step if
   `matcherUrl` was pre-configured.)

2. **Find services.**

   _You:_ "Find me a service that can sign a message with my wallet."

   Expected tool: `discovery_find_services(description: "sign a
   message with my wallet")`. Expected response: PersonalMessageSigner
   as the top candidate. The LLM bridge ranks candidates against the
   query, so the exact response shape depends on the model's output,
   but a competently-configured model should pick PMS clearly and
   either omit Echo/RandomNumber or rank them well below it. Each
   returned candidate carries a `contact (public): ocap:…` URL plus
   a `rationale` string in the model's own words. If you see a
   "bridge query error" or "bridge ingest error" message instead,
   check `~/.ocap/matcher-llm-bridge.log` and the openclaw gateway
   config (token + chatCompletions endpoint enabled).

3. **Inspect PMS.**

   _You:_ "Show me what that wallet service can do."

   Expected tool: `service_get_description(contact: "<PMS contact URL>")`.
   Expected response: ServiceDescription with `getAccounts` and
   `signMessage` in the remotable spec.

4. **Obtain the PMS service.**

   _You:_ "Connect to it."

   Expected tool: `service_initiate_contact(contact: "<PMS contact URL>")`.
   Expected response: `Obtained service "PersonalMessageSigner" (kref koN)`.
   Expected provider-side: **no** approval popup at this point —
   contact initiation itself is Public.

5. **List accounts.**

   _You:_ "What accounts do I have?"

   Expected tool: `service_call(service: "PersonalMessageSigner", method: "getAccounts")`.
   Expected response: array of 0x-prefixed addresses.

6. **Sign a message.**

   _You:_ "Sign 'hello world' with the first one."

   Expected tool: `service_call(service: "PersonalMessageSigner",
   method: "signMessage", args: '["0x…", "hello world", "0x1"]')`.
   Expected provider-side: **approval popup in the browser**. Approve
   it. Expected response: hex signature.

7. **Inventory.**

   _You:_ "What services do you have access to right now?"

   Expected tool: `discovery_list_tracked`. Expected response:
   matcher + one contact + one service (PMS).

## Stage C — Exercise the other two services

Repeat steps 3–5 for `EchoService` and `RandomNumberService`:

- Echo: call `echo("testing 1 2 3")`; expect `"testing 1 2 3"`.
- RandomNumber: call `randomInt(1, 100)`; expect an integer in
  [1, 100]. Call `randomFloat()`; expect a float in [0, 1).

Neither triggers an approval popup — they have no access-controlled
backing.

After these, `discovery_list_tracked` should show 3 contacts and 3
services.

## Stage D — Failure-path sanity

Light-touch. Prompts the agent to hit edge cases.

- Start a fresh `openclaw tui` session (so the plugin state is
  clean) and, **without** running `discovery_redeem_matcher`, say
  "find a service that signs messages." The `discovery_find_services`
  tool should reject with the "No matcher connection. …" guidance
  string from `requireMatcher`.
- Ask the agent to call an unknown capability:
  "call `doThing` on the NotARealService service." The
  `service_call` tool should reject with "Unknown service …
  Available: …".
- (Informational only) `service_initiate_contact` on a Public
  contact should succeed with a service reference; a non-Public
  response would be reported as "non-public response". We don't
  currently have a non-Public contact to test this branch against.

## What "passing" looks like

- Stage B steps 1–7 each complete with the expected tool call and
  response.
- The matcher daemon log shows a new
  `[matcher] findServices(…) → N match(es)` entry for every query;
  `N` depends on whether the query overlaps the registered services'
  descriptions and method names.
- The offscreen console log shows one approval/signing exchange per
  `signMessage` call, with no regressions in the underlying
  `hostApiProxy` path.
- Stage C steps complete without triggering the browser (services
  are self-contained).
- Stage D produces clear, user-legible errors.

## Known limitations going in

- Matcher `findServices` uses an LLM-backed Stage-2 ranker via
  `@ocap/llm-bridge`, which calls openclaw's
  `/v1/chat/completions`. The bridge is started by
  `start-matcher.sh` and writes to `~/.ocap/matcher-llm-bridge.log`.
  Bridge errors propagate to the consumer rather than falling back
  to a heuristic ranker — silent fallbacks would hide LLM-side
  problems during development. Stage-3 RAG-style indexing is the
  next planned step; today every registration's full digest sits
  in the matcher's LLM context window.
- Matcher URL is stable across plain daemon restarts of the same
  OCAP home (durable `publicFacet` kref + persisted peer ID and
  encryption key), but **re-running `start-matcher.sh` allocates a
  fresh subcluster** and so still yields a new URL. The launcher
  fix to detect and reuse an existing matcher subcluster is the
  Part 2 follow-up in `discovery-plan.md`.
- Matcher registry is **in-memory**; on matcher restart it starts
  empty and providers must re-register. Durable registry + liveness
  is the same `discovery-plan.md` follow-up.
- Matcher registry accumulates duplicates on provider re-registration
  without a restart of the matcher (planned follow-up: dedup/liveness).
- Provider restart without a matcher restart triggers ocap-kernel
  issue #944 (duplicate-seq).
- Only Public access model is wired end-to-end. Permissioned and
  ValidatedClient contact responses are reported verbatim but not
  driven through.
