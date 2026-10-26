# Gator + Endo Integration

This document describes how [MetaMask Delegation Framework
("Gator")](https://github.com/MetaMask/delegation-framework) is integrated with
the ocap kernel. Gator constructs capabilities. Endo `M.*` patterns make them
discoverable.

## Conceptual model

```
  Delegation grant
  ┌──────────────────────────────────────────────────────┐
  │  delegation   ← redeemable bytestring (signed, EIP-7702)
  │  caveatSpecs  ← readable description of active caveats
  │  methodName   ← which catalog operation this enables
  │  token?       ← ERC-20 contract in play (if any)
  └──────────────────────────────────────────────────────┘
           │
           │  makeDelegationTwin()
           ▼
  Delegation twin (discoverable exo)
  ┌──────────────────────────────────────────────────────┐
  │  transfer / approve / call  ← ocap capability methods
  │  getBalance?                ← optional read method
  │  SpendTracker               ← local mirror of on-chain state
  │  InterfaceGuard             ← M.* patterns derived from caveats
  └──────────────────────────────────────────────────────┘
           │
           │  makeDiscoverableExo()
           ▼
  Discoverable capability
  (surfaced to agents via kernel capability discovery)
```

### Delegation grants

A delegation grant is a **serializable, describable** version of a delegation.
It holds two things together:

- **`delegation`** — the redeemable bytestring: a fully-formed, signed
  delegation struct ready to pass to `redeemDelegation` on-chain. This is
  the authoritative bytes; everything else is derived from it.

- **`caveatSpecs`** — a structured, human-readable description of the caveats
  in effect. Unlike raw `caveats` (which are opaque encoded calldata passed to
  enforcer contracts), `caveatSpecs` name the constraint and its parameters in
  terms the application can reason about: `{ type: 'cumulativeSpend', token,
  max }`, `{ type: 'allowedCalldata', dataStart, value }`, etc.

Grants are what get stored and transmitted. They can be reconstructed into
twins whenever a live capability is needed.

### Delegation twins

A delegation twin is a **local capability** that wraps a grant and gives it an
ocap interface. The twin:

- Exposes the delegation's permitted operations as callable methods
- Derives its interface guard from the grant's `caveatSpecs`, so a call that
  would fail on-chain (e.g., wrong recipient, over-budget) is rejected locally
  first with a descriptive error
- Tracks stateful caveats locally — cumulative spend, value limits — as a
  **latent mirror** of on-chain state

The local tracker is advisory, not authoritative. On-chain state is the truth.
If spend is tracked externally (e.g., another redemption outside this twin), the
local tracker will optimistically allow a call that the chain will reject. The
twin's job is to provide fast pre-rejection and a structured capability
interface, not to replace the on-chain enforcer.

### M.\* patterns and discoverability

`M.*` interface guards serve two purposes:

1. **Discoverability** — `makeDiscoverableExo` attaches the interface guard and
   method schema to the exo. The kernel's capability discovery mechanism reads
   these to surface the capability to agents, including what methods are
   available and what arguments they accept.

2. **Pre-validation** — the guard can narrow the accepted argument shapes based
   on the active caveats. If an `allowedCalldata` caveat pins the first argument
   to a specific address, the corresponding guard uses that literal as the
   pattern, so a call with any other address is rejected before hitting the
   network.

---

## Caveat → guard mapping

The following table maps Gator caveat enforcers to the `M.*` patterns used in
delegation twin interface guards.

### Execution-envelope caveats

These constrain the execution itself (target, selector, value), not individual
calldata arguments. They are represented in `caveatSpecs` and influence the
twin's behavior but do not correspond to argument-level `M.*` patterns.

| Caveat enforcer                     | CaveatSpec type    | Twin behavior                                       |
| ----------------------------------- | ------------------ | --------------------------------------------------- |
| `AllowedTargetsEnforcer`            | _(structural)_     | Determines which contract the twin calls            |
| `AllowedMethodsEnforcer`            | _(structural)_     | Determines which function selector the twin uses    |
| `ValueLteEnforcer`                  | `valueLte`         | Local pre-check: rejects calls where `value > max`  |
| `ERC20TransferAmountEnforcer`       | `cumulativeSpend`  | Local SpendTracker: rejects when cumulative `> max` |
| `NativeTokenTransferAmountEnforcer` | _(not yet mapped)_ | —                                                   |
| `LimitedCallsEnforcer`              | _(not yet mapped)_ | —                                                   |
| `TimestampEnforcer`                 | `blockWindow`      | Stored in caveatSpecs; not yet locally enforced     |

### Calldata argument caveats → M.\* patterns

| CaveatSpec type / enforcer                     | M.\* pattern                | Notes                                                                   |
| ---------------------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `allowedCalldata` at offset 4 (first arg)      | Literal address value       | Pins the first argument of transfer/approve to a specific address       |
| `allowedCalldata` at offset N (any static arg) | Literal value (ABI-encoded) | Any static ABI type (address, uint256, bool, bytes32) at a known offset |
| _(no calldata constraint)_                     | `M.string()` / `M.scalar()` | Unconstrained argument                                                  |

### Overlap at a glance

```
        Endo M.* patterns              Gator enforcers
       ┌────────────────────┐         ┌─────────────────────────┐
       │                    │         │                         │
       │  M.not()           │         │  Stateful:              │
       │  M.neq()           │         │   ERC20Transfer         │
       │  M.gt/gte/lt/      │         │   AmountEnforcer        │
       │   lte() on args    │         │   LimitedCalls          │
       │  M.nat()           │         │   NativeToken           │
       │  M.splitRecord     │         │   TransferAmount        │
       │  M.splitArray      │         │                         │
       │  M.partial     ┌────────────────────────┐              │
       │  M.record      │      SHARED            │              │
       │  M.array       │                        │              │
       │                │  Literal/eq pinning    │              │
       │                │  AND (conjunction)     │              │
       │                │  OR  (disjunction)     │              │
       │                │  Unconstrained         │              │
       │                │   (any/string/scalar)  │              │
       │                │  Temporal:             │              │
       │                │   Timestamp            │              │
       │                │   BlockNumber          │              │
       │                └────────────────────────┘              │
       │                    │            │                      │
       └────────────────────┘            └──────────────────────┘

  Endo-only: negation,       Shared: equality,        Gator-only: stateful
  range checks on args,      logic operators,         tracking, execution
  structural patterns,       unconstrained,           envelope, (target,
  dynamic ABI types          temporal constraints     selector, value)
```

---

## What maps well

For contracts with a **completely static ABI** (all arguments are fixed-size
types like address, uint256, bool, bytes32):

1. **Literal pinning**: Fully supported via `AllowedCalldataEnforcer`. Each
   pinned argument is one caveat. Maps to a literal value as the `M.*` pattern.

2. **Conjunction**: Naturally expressed as multiple caveats on the same
   delegation. `M.and` is implicit.

3. **Disjunction**: Supported via `LogicalOrWrapperEnforcer`, but note that the
   **redeemer** chooses which group to satisfy — all groups must represent
   equally acceptable outcomes.

4. **Unconstrained args**: Omit the enforcer. Use `M.string()` or `M.scalar()`.

## What does not map

1. **Range checks on calldata args**: `M.gt(n)`, `M.gte(n)`, `M.lt(n)`,
   `M.lte(n)`, `M.nat()` have no calldata-level enforcer. `ValueLteEnforcer`
   only constrains the execution's `value` field (native token amount). A custom
   enforcer contract would be needed.

2. **Negation**: `M.not(p)`, `M.neq(v)` have no on-chain equivalent. Gator
   enforcers are allowlists, not denylists.

3. **Dynamic ABI types**: `string`, `bytes`, arrays, and nested structs use ABI
   offset indirection. `AllowedCalldataEnforcer` is fragile for these — you'd
   need to pin the offset pointer, the length, and the data separately. Not
   recommended.

4. **Stateful patterns**: `M.*` patterns are stateless. Stateful enforcers
   (`ERC20TransferAmountEnforcer`, `LimitedCallsEnforcer`, etc.) maintain
   on-chain state across invocations. The twin's local trackers mirror this
   state but are not authoritative.

5. **Structural patterns**: `M.splitRecord`, `M.splitArray`, `M.partial` operate
   on JS object/array structure that doesn't exist in flat ABI calldata.

---

## The AllowedCalldataEnforcer

The key bridge between the two systems is `AllowedCalldataEnforcer`. It
validates that a byte range of the execution calldata matches an expected value:

```
terms = [32-byte offset] ++ [expected bytes]
```

For a function with a static ABI, every argument occupies a fixed 32-byte slot
at a known offset from the start of calldata (after the 4-byte selector):

| Arg index | Offset  |
| --------- | ------- |
| 0         | 4       |
| 1         | 36      |
| 2         | 68      |
| n         | 4 + 32n |

This means independent arguments can each be constrained by stacking multiple
`allowedCalldata` caveats with different offsets. In `delegation-twin.ts`,
`allowedCalldata` entries at offset 4 are read from `caveatSpecs` and used to
narrow the first-argument pattern in the exo interface guard.
