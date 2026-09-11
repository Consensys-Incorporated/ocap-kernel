# Attenuation by narrowing

Narrowing is the most restricted useful form of attenuation, and the restriction
buys something valuable: narrowings of a common capability form a lattice whose
join and meet are computable syntactically, with no ambiguity about how
overlapping grants combine. This document specifies a first implementation as a
library, and the kernel integration it is meant to lead to.

## What narrowing is

`B` is a **narrowing** of `A` when every method of `B` is an unaltered forward to
the same method of `A`. If `A` implements `{ foo(x: X) }`, then `B` is a
narrowing of `A` iff `B`'s interface is `{ foo(x: X') }` for some `X' ≤ X` and
`B.foo` is equivalent to `(x) => A.foo(x)`. A narrowing may omit methods of the
capability it narrows, but it must not add any.

Over `@endo/exo` interface guards this admits a normal form: when
`guard(B.foo) = AND(guard(A.foo), X)` for arbitrary `X`, then — given the
forwarding implementation — `B` is definitely a narrowing of `A`.

The normal form is not a syntactic test, because a pattern can be a subpattern of
`guard(A.foo)` without being written as a conjunction with it. So one cannot
conclude from a guard's not being spelled that way that it is not a narrowing.
What matters is the other two properties. The form is **total**: any
`P ≤ guard(A.foo)` is equivalent to `AND(guard(A.foo), P)`, so every narrowing's
guard can be represented in it — though not uniquely, since many `X` yield
equivalent conjunctions. And it is **sound**: a capability whose guard is in
normal form with respect to what it narrows is a narrowing of it. Producing
guards in that form is therefore enough, and is what this design does.

Three things are excluded, deliberately:

- **Rewriting arguments.** A capability that translates `readFile(['x'])` into
  `readFile(['srv', 'data', 'x'])` is not forwarding unaltered. This rules out
  chroot-style re-basing, and so forces absolute paths (see
  [The fs capability](#the-fs-capability)).
- **Narrowing return values.** A post-condition filter can fail where the base
  succeeds, so it is not an unaltered forward. Return guards are inherited
  verbatim.
- **Adding behavior.** Logging, caching, and rate limiting are attenuations but
  not narrowings, and they do not compose without ambiguity. They are out of
  scope here.

## Why this belongs in the kernel eventually

The ocap kernel manages the membrane that every external capability crosses to
reach vat code, and its kref/vref translation tables give it a
kernel-transparent view of reference passing. When `B` passes `C` a reference it
received from `A`, the kernel routes `C`'s invocations straight to `A` rather
than through `B`, and the kref answers "are these two references to the same
object?".

Narrowing extends that structure to a form of delegation more exotic than direct
reference passing. Given `kernel.narrow(ko2, X)` producing `ko7` and
`kernel.narrow(ko2, Z)` producing `ko9`, the kernel can compute
`kernel.join(ko7, ko9)` as `kernel.narrow(ko2, OR(X, Z))` — purely
syntactically, because it minted both and knows their common base.

The first implementation is nonetheless a library, imported by vat code. That
fixes the usercode-level shape at no cost to the kernel, and lets the kernel
integration be motivated by a use case — one vat handing a scoped capability to
another — rather than by anticipation.

## The library

Exported from `@metamask/kernel-utils`:

```ts
narrow({ name, base, delta }): Promise<Exo>
join({ name, refs }): Promise<Exo>
pathUnder(segments: string[]): Pattern
```

`narrow` reads `base`'s interface guard, conjoins each pattern in `delta` onto
the corresponding argument position, and returns a new exo whose methods forward
to `base` through `E()`:

```js
const scoped = await narrow({
  name: 'DataFs',
  base: fs,
  delta: { readFile: [pathUnder(['srv', 'data'])] },
});
```

Given a base guarded as

```js
M.interface('Fs', {
  readFile: M.callWhen(M.arrayOf(M.string()), M.string()).returns(M.string()),
  access: M.callWhen(M.arrayOf(M.string()))
    .optional(M.number())
    .returns(M.undefined()),
});
```

the result is guarded as

```js
M.interface('DataFs', {
  readFile: M.callWhen(
    M.and(M.arrayOf(M.string()), pathUnder(['srv', 'data'])),
    M.string(),
  ).returns(M.string()),
});
```

Arity, optional and rest positions, and the return guard are inherited
verbatim — the delta has length one, so `readFile`'s encoding argument survives
untouched. `access` is gone because the delta did not name it.

### Enforcement is the returned exo's guard

The exo machinery validates arguments against the method guards before dispatch,
so the narrowing needs no separate check. This is not only an economy: because
`narrow` _constructs_ `AND(guard(base), X)` rather than accepting a
caller-supplied guard and verifying it, `guard(B) ≤ guard(A)` holds by
construction. That is the precondition under which `OR` of two deltas is
guaranteed to still be a narrowing, and therefore what makes `join` sound
without a pattern subtyping decision procedure — which the library does not have
and should not grow.

For the same reason there is no variant taking a complete `InterfaceGuard`. Such
a guard could describe a region outside `guard(A)`; effective authority would
still be safe, since the forward hits the base exo which enforces its own guard,
but the narrowing would _advertise_ calls that fail downstream, `guard(B) ≤
guard(A)` would no longer hold syntactically, and a `join` over such deltas would
compute a lattice element that is not a narrowing of anything.

### NarrowingDelta

```ts
type NarrowingDelta = Record<string, (Pattern | undefined)[]>;
```

A delta maps a method name to patterns addressed by argument position.

| Written                       | Means                                                          |
| ----------------------------- | -------------------------------------------------------------- |
| method absent from the delta  | the method is dropped from the result                          |
| `{ readFile: [p] }`           | argument 0 conjoined with `p`; later positions unchanged       |
| `{ writeAt: [p, undefined] }` | argument 0 conjoined with `p`; argument 1 explicitly unchanged |
| `{ seek: [, M.lte(4096)] }`   | argument 0 unchanged; argument 1 conjoined                     |
| `{ readFile: [] }`            | the method is kept entirely unchanged                          |

Dropping by omission makes the safe outcome the default: forgetting a method
removes authority rather than granting it. Keeping a wide API therefore means
listing each method with an empty delta.

Position `i` addresses the base's guard at `i`, walking required arguments, then
optionals, then the rest guard, and stays in whichever category it lands in — a
delta cannot promote an optional argument to required, and cannot change arity.
It is an error for a delta to name a method the base does not have, or a position
beyond the base's maximum arity when the base has no rest guard.

A position that lands in the rest guard conjoins onto it. Since a rest guard is
one pattern over all trailing arguments, the conjunction constrains every one of
them rather than only the position named, and several such positions conjoin onto
the same guard. `guard(B) ≤ guard(A)` still holds and the forward is still
unaltered, and the surprise runs in the safe direction: the author gets less
authority than intended, never more.

### Default-guarded bases

Most exos in this repo are built with `makeDefaultExo`, which produces
`M.interface(name, {}, { defaultGuards: 'passable' })` — an empty `methodGuards`
map, so there is no per-method guard to conjoin onto.

`defaultGuards: 'passable'` means every method admits any passable arguments, so
for a method absent from `methodGuards` a delta of length _n_ synthesizes

```js
M.callWhen(...deltaPatterns)
  .rest(M.any())
  .returns(M.any());
```

This is sound on the same grounds as the general case: the synthesized guard
admits no more calls than the base's own, and the method still forwards
unaltered. Because the interface names no methods, a delta naming a method the
base does not implement is caught at call time rather than at narrowing time.

### Provenance and flattening

`narrow` records `{ base, delta, baseGuard }` in a `WeakMap` keyed by the exo it
returns. Caching `baseGuard` matters because narrowing a narrowing then needs no
guard fetch, so a chain of any depth costs one fetch in total.

Narrowing a narrowing **flattens**: `narrow(B, Y)` where `B` is
`{ base: A, delta: X }` records `{ base: A, delta: AND(X, Y) }`, and the returned
exo forwards directly to `A`.

```js
const b = await narrow({ name: 'B', base: a, delta: x });
const c = await narrow({ name: 'C', base: b, delta: y }); // -> { base: a, delta: AND(x, y) }
const d = await narrow({ name: 'D', base: a, delta: z }); // -> { base: a, delta: z }
await join({ name: 'CD', refs: [c, d] }); // fine: common base a
```

Flattening is what makes `join` work across the whole narrowing tree rather than
only between siblings, and it keeps forwarding one hop deep regardless of depth.
It is also the library-level analogue of the kernel not routing `C`'s invocations
through `B`.

It has a consequence to plan around: because `C` never touches `B`, a future
`revoke(B)` would leave `C` fully functional. Revocation therefore has to be
defined over a `(base, delta-region)` pair rather than over a link in a chain.

### join

`join` takes any number of refs and returns a narrowing of their common base
admitting exactly what any of them admits.

```js
// b:  { readFile: [pathUnder(['srv', 'data'])] }
// b': { readFile: [pathUnder(['srv', 'logs'])], access: [pathUnder(['srv', 'logs'])] }
await join({ name: 'DataAndLogs', refs: [b, bPrime] });
// -> { readFile: [OR(data, logs)], access: [pathUnder(['srv', 'logs'])] }
```

- Every ref must carry a provenance record naming the same base. A ref the
  library did not mint throws.
- The unnarrowed base is a legal operand and absorbs, so the lattice has a
  representable top and a fold over a list needs no special case.
- The result's method set is the union of the operands'.
- Where two operands name the same method, each argument position is disjoined.

A missing method and a hole behave differently, which is easier to read as one
rule than two: the join is a union of authority, a method absent from an operand
contributes the empty set, and a hole contributes everything. So a method only
one operand names appears at that operand's delta, while a hole on either side
leaves that position unconstrained in the result.

### Guard algebra

The positional traversal — walk `argGuards`, then `optionalArgGuards`, then
`restArgGuard`, combine, and reassemble via the `M.callWhen → optional → rest →
returns` builder chain — is shared with the `sheaves` package, whose
`collectSheafGuard` already implements the `OR` direction as the dual of the `AND`
direction needed here. That traversal, along with `buildMethodGuard` and
`asyncifyMethodGuards`, moves into `kernel-utils`, and `sheaves` imports it. The
dependency edge already exists in that direction.

### pathUnder

```js
const pathUnder = (segments) =>
  M.splitArray(
    segments.map(M.eq),
    [],
    M.arrayOf(M.and(M.string(), M.not(M.eq('..')))),
  );
```

`M.splitArray(required, optional, rest)` matches an array whose leading elements
match `required` and whose remainder matches `rest`, which is an exact prefix
matcher for segment arrays.

The segment form is why authority-relevant arguments are arrays of path segments
rather than strings. A string path needs normalization before matching —
`M.and(M.gte('/srv/data/'), M.lte('/srv/data/￿'))` admits
`/srv/data/../../etc/passwd` — and normalization is per-capability knowledge that
does not belong in a pattern vocabulary. With segments the obligation shrinks but
does not vanish. A pattern cannot see inside a segment, so
`['srv', 'data/../../etc']` satisfies `pathUnder(['srv'])`: traversal is
unrepresentable only once `..` is excluded _and_ every segment is known to
address exactly one path component. `fs` therefore rejects any segment containing
a path separator, or equal to `.` or `..`, which is what makes the prefix
comparison sufficient — in one place shared by every platform, before any
platform-specific caveat and before segments are joined into a path.

The same shape serves any capability whose authority is hierarchical, provided
the hierarchy is written most-significant-first. Host names are
least-significant-first, so a `fetch` capability narrowed by domain wants
reversed host segments — `['com', 'example']` for `*.example.com` — at which
point domain scoping is the identical prefix construction.

### Asynchrony

`narrow` is always async and forwards through `E()`, whether or not the base is
local. One code path survives the base later being a cross-vat presence, which is
where kernel integration begins, and a remote base's guard can only be fetched
asynchronously anyway. The cost is that derived guards are `M.callWhen` and every
narrowed method returns a promise, so a base with synchronous methods cannot be
narrowed while keeping them synchronous.

## The fs capability

`@metamask/kernel-platforms` vends `fs` as an exo. This replaces the previous
`node:fs` lookalike record of caveated functions; there is no compatibility
shim, and `existsSync` is gone, which the promises-only forwarding requires in
any case.

Methods take absolute segment arrays:

```js
await E(fs).readFile(['srv', 'data', 'x'], 'utf8');
```

The encoding is required rather than optional because a typed array is not
Passable, so `readFile` cannot return one and there is nothing for an omitted
encoding to mean.

Absolute rather than root-relative, because the alternative is re-basing a
narrowed holder's coordinate system, and rewriting arguments is not an unaltered
forward. The price is that a narrowed holder sees prefix segments it has no
authority over. In exchange the capability is self-describing: its
`GET_INTERFACE_GUARD` reveals its own `pathUnder` prefix, which a capability that
re-based coordinates could not. The guard is not the whole precondition, though —
it admits malformed segments the capability rejects, and it bounds coordinates
rather than the resources they reach (see [Limits](#limits)).

### Config is the root of the narrowing tree

Per-vat platform config already expressed narrowings, in an ad-hoc
per-capability vocabulary: `promises: { readFile: true }` restricted the method
set, and `rootDir` restricted the argument. Under this design it says the same
things in the same vocabulary the library uses:

```json
"platformConfig": {
  "fs": {
    "root": ["srv", "data"],
    "methods": ["readFile"]
  }
}
```

The capability factory compiles that into a delta and applies the same `narrow`
the library exports, so the config-time bound is provably the root of the
narrowing tree rather than a parallel mechanism. Root segments are absolute; an
empty `root` would denote the entire filesystem and is a config error. Any
platform-specific prefix is a leading segment, so a Windows drive is
`["C:", "srv"]`.

Config stays JSON — it is a config file validated by superstruct — while patterns
are Passable tagged records, so a config narrowing cannot itself be a delta and
has to be sugar that compiles to one. The sugar is per-capability: `fs` defines
what `root` means, and a future `fetch` capability defines its own spelling. A
single JSON encoding of deltas that every capability shares would unify them, and
is on the roadmap rather than in this design; the compile step is a separate
function so that introducing one does not mean rewriting the capability.

## Limits

**Patterns cannot constrain a leaf value's internal structure.** `M.string()`
admits `'data/../../etc'`, and the vocabulary has no regex or glob to narrow it
with. So any capability whose authority is hierarchical must
check that its segments are well-formed before a prefix pattern carries weight —
for `fs`, one path component each; for the reversed-host-segment `fetch`
narrowing on the roadmap, one label each, since a segment containing a dot would
span several.

**Aliasing defeats syntactic narrowing, and `fs` does not yet stop it.** Patterns
are equally blind to the filesystem: a symlink at `/srv/data/evil -> /etc` makes
`['srv', 'data', 'evil', 'passwd']` satisfy `pathUnder(['srv', 'data'])`.
`makeNoSymlinksCaveat` catches only a symlink in the final position, because
`lstat` follows every intermediate component, so a holder of a narrowed or
config-scoped `fs` can read outside its root if anyone can place a directory
symlink inside it. Syntactic narrowing is sound only over a namespace that is not
self-aliasing, and each capability owns that property for its own namespace —
which `fs` has yet to do.

**Arity is not narrowable.** A delta constrains patterns at inherited positions
and cannot drop trailing optionals or make an optional required.

**Return values are not narrowable**, as above.

**Arguments and results must be Passable.** Forwarding through `E()` marshals
every value, and `@endo/pass-style` rejects `Buffer` and `Uint8Array` alike as
mutable typed arrays, which `harden` does not change. So `fs.readFile` requires
an encoding and returns a string, and the `fetch` narrowing on the roadmap meets
the same constraint in its response bodies.

**Non-narrowing attenuations are out of scope.** Anything that alters, augments,
or filters rather than forwarding — including the state-dependent cases such as
"only on Wednesday" or "usable four times" — needs machinery this design does not
provide.

## Roadmap

**Close the symlink hole in `fs`.** Either resolve each path with `realpath` and
re-check the prefix, or walk it a component at a time with `O_NOFOLLOW`. Both are
TOCTOU-prone, and `realpath` additionally rejects a legitimately symlinked root,
which is why this is its own change rather than a rider on the narrowing work.

**Restore raw-byte reads.** `harden(buffer.transferToImmutable())` is Passable,
with `byteArray` pass style, so `readFile` could return bytes after all. Deferred
because `transferToImmutable` is not guaranteed at the declared `engines: >=22`,
and because a caller would then handle an `ArrayBuffer` rather than a `Buffer`.

**Re-vend `fetch` by reversed host segments**, replacing `network.allowedHosts`
with narrowings of a request exo. This is the case that forced the segment
design, and proves the vocabulary generalizes past one capability before the
kernel commits to it.

**A kernel `narrow` service**, so narrowings can be minted for and passed between
vats, with the `WeakMap` becoming a kernel store table keyed by kref. Any vat
holding a reference may narrow it, and possession needs no verification: the
target arrives as a slot in `methargs`, and liveslots only translates a vref to a
kref for references the sending vat actually holds.

Implement the narrowed object as a kernel-hosted forwarder first — checking the
delta and re-sending to the base — which needs no change to routing, then migrate
to retargeting in `KernelRouter`, which resolves the base owner during routing
and delivers in a single crank. Record `(base, delta)` in the store from the
outset either way. That record is not merely groundwork for the migration: the
kernel sweeps every anonymous kernel object at startup by design, since such an
object has no name to be re-registered under, so narrowings need their own
persistent category to survive a restart at all. Deltas are Passable, so they
serialize into the store directly.

**Revocation** over `(base, delta-region)`, per the consequence of flattening
described above.

**A general JSON delta encoding**, so `fs` and `fetch` config share one spelling.

**Stateful narrowings** — "only on Wednesday", "usable four times" — which need a
leaf kind patterns cannot express, and therefore probably need the kernel to hold
the state.
