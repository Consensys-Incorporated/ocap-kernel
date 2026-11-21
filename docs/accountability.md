# Accountability and provenance

We aggressively promote the capability security model, realized in the Ocap
Kernel as **object capabilities** (**ocaps**), as the preferred alternative to
the much more commonly used Identity Based Access Control (IBAC) model, since
the latter is fatally flawed (in a pragmatic if not a pure theoretical sense)
due to the Confused Deputy problem. This does not take identity out of the story
though, since we still need to incorporate it at the boundaries of the system
where responsibility for specific exercises of authority is tied to specific,
named, accountable entities external to the system, such as individual people,
corporations, or other organizations or institutions. This is essential for
proper governance within organizations and for tracking liabilities between
real-world actors.

The kernel represents authority as object references and routes every vat
crossing exercise of authority through itself, so it is positioned to record who
did what with which capability. However, as currently implemented it does not
contain any mechanisms for actually doing any of that. This document works out
what such record keeping should capture, what it should cost, how it ties
kernel-level events to the parties outside the system who are answerable for
them, and how to build it in stages.

## Terms and concepts

An **accountable party**, or just **party**, is an identifiable external entity
that can be held responsible for its actions: a person, a corporation, an
institution. This is deliberately distinct from a **principal** in the
conventional sense of an entity to which permission may be granted, because, in
many traditional access control frameworks, a principal may also be a process, a
service, a virtual machine, or a bot, none of which can innately be held to
account for what they do.

An **ocap** is an unforgeable reference to an object that carries the means to
use the authority it represents, either because the object possesses that means
innately or because it holds other ocaps that jointly or individually embody it.
Ocaps are **held** by objects and by parties. An object employs the ocaps it
holds directly. A party employs them indirectly, through intermediate software
that keeps track of which ocaps the party holds and gives the party user
interface affordances to direct their use.

The authority an ocap represents can be **employed** in three ways:

- **exercised** to do whatever the authority allows doing;
- **conveyed** to another object or party, which then holds it as well and
  decides for itself what to do with it;
- **incorporated** into a new object that packages the authority in some
  usefully distinct form.

An object holding an ocap can present a **subset** of its authority, in any form
its implementation cares to realize: a strict narrowing of functionality, a
modulation of the parameters it will pass, a faceted revoker, or anything else
its developer's imagination can conceive, subject only to the limitation that it
cannot expand the authority it was given. An object holding several ocaps can
present operations that **combine** them synergistically, offering operations
that are impossible to provide via those ocaps individually but _are_ possible
if those ocaps are used together. For example, an object given an input stream
and an output stream can offer the authority to copy from one to the other. In
every case of subsetting or combination, additional parties become associated
with the result: whoever was responsible for designing and creating the logic
that realizes it, which this document calls its **implementer**, as distinct
from the **operator** of the system it runs in, who is responsible, among other
things, for allowing the implementation into the system.

The object reference graph of an ocap system is therefore its current authority
graph. It also implicitly embodies the provenance of the authorities from which
it was constructed: every action could, in principle, be associated with the
parties whose acts of exercise, conveyance, incorporation, and implementation
made it possible. "Implicitly" is the problem: once B holds a reference to A,
the graph does not say how B got it, and with no record kept at the time,
nothing does. However, with suitable record keeping, accountability for any
action taken could be realized, tracing the chain of causality from whatever the
initiating act was to whatever consequences followed.

## What the kernel can see

The kernel is where every vat crossing exercise and conveyance of authority
passes, and where observation and intervention are cheapest, so the design below
associates each mode of employment with a kernel event wherever one exists,
rather than with the in-vat action that produces it. Not every mode has one.

| Mode of employment  | Kernel event                                                                                                   | Where it is observable today                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| exercise            | a message delivered to an object                                                                               | `KernelRouter.#deliverSend`                                                                 |
| conveyance          | an object reference carried in a delivered message's arguments, or in the value a promise is resolved to       | the slots of `methargs` in `#deliverSend`; the slots of each resolution in `#deliverNotify` |
| incorporation       | an ocap used in the construction of an object                                                                  | not observable by the kernel; see below                                                     |
| implementation      | a vat launched from a bundle                                                                                   | `SubclusterManager` and `bundle-loader.ts`                                                  |
| external initiation | a host call to `queueMessage`: an exercise of the target from outside, and a conveyance of whatever it carries | `KernelQueue.enqueueMessage`                                                                |

Two of these need qualification.

**Incorporation has no kernel event.** An ocap enters an object's construction
through a constructor or factory parameter or through lexical closure, and the
kernel sees neither; liveslots might see the first for durable kinds, and
nothing sees the second. The kernel cannot say which of a vat's objects
incorporates which of the vat's imports. What it can say is which vat holds
the import and which vat owns the object, so responsibility for what an
object incorporates falls to the parties behind its vat. The exception is an
incorporation the kernel itself performs, such as a narrowing minted by a
kernel `narrow` service, which it can record exactly.

**Implementation is bundle-granular.** The party that matters is the
implementer of the specific object the ocap is incorporated into, but an
object's behavior is an amalgam of its own methods, helper functions it calls,
and library code it imports, none of which the kernel can separate from the
rest of the bundle. The vat bundle is the finest unit of implementation the
kernel can attribute.

What machinery produces a `queueMessage` call, and how a party expresses the
intention behind it, is taken up under [Acts by parties](#acts-by-parties).

Three gaps keep the observable events from adding up to a causal chain:

- **A send forgets its sender.** `RunQueueItemSend` is `{ type, target, message
  }`. The sender is known where the item is created (`VatSyscall.vatId`, the
  remote's `RemoteId`, or the host) and dropped at `enqueueSend`. By delivery
  time the kernel cannot say who exercised the authority.
- **A crank has no identity.** Nothing numbers cranks, so a delivery cannot
  name the delivery that caused it, and a conveyance cannot name the
  message that carried the reference.
- **An endpoint has no party.** The kernel's endpoints are its own vats and
  the remote kernels it is connected to. A remote kernel is to this kernel
  what a vat is to it: an enclosure of entities whose internal distinctions it
  can only take on the enclosure's word, and so must treat as potentially
  colluding. Each is a unit of software, and nothing binds either kind to a
  person or an organization.

There is also a limit that no kernel change removes. Every mode of employment
also happens inside a vat, between objects that share a process and call each
other directly, and none of that crosses the kernel. The kernel sees vats, not
the objects within them. When vat B holds references to A and C and offers an
operation that uses both, the kernel sees A and C conveyed to B and, later,
sends from B to A and C within the crank that delivered to B. That is enough
to reconstruct the synergy at vat granularity, and to say which of B's ocaps
were exercised in response to which exercise of B's exports. It is not enough
to see which of B's objects did it, how the authority moved between B's
objects on the way, or what B's objects incorporated. The causal pathway
through a vat is opaque to the kernel, and so is any causation carried by vat
state from one crank to a later one. The vat is therefore the unit at which
the kernel can attribute responsibility. Application developers may need
finer accounting than that, and [Inside the vat](#inside-the-vat) takes up
what can be added below the kernel and at what cost in trust.

## Principles

**Identifiers are always on; records are opt-in.** Carrying a sender and a
crank number on an in-flight item costs a few bytes that die with the item.
Writing a durable record costs storage forever. The former is cheap enough to
do unconditionally and is what makes the latter meaningful when someone asks
for it.

**Records commit with the crank.** Every record is written inside the crank's
savepoint, so a rolled-back delivery leaves no record and a committed record
describes something that happened. Attempts are a logger concern, not an
accountability concern.

**Records outlive objects.** An object's records are the evidence of what was
done with it, and might well be needed after it is gone. Records do not pin the
object, and collecting the object does not delete them. Retention is a separate,
explicit operation.

**Identity is for the record, not the gate.** Nothing here changes who may
send what to whom. A kernel-asserted sender is made available so that an
exercise of authority can be attributed; a vat that makes access decisions on
it is reinventing the ambient-authority problem this system exists to avoid,
and the documentation of every affordance below says so.

**A party without provenance is the origin.** When a chain of custody
crosses a kernel boundary and the sending kernel does not say where it got the
reference, the receiving kernel records that kernel's party as the source.
Stripping provenance is assuming responsibility. This is how liability works
in physical supply chains, and it is what makes self-reported segments
usable without a global verifier.

**The kernel reports; the host interprets.** The kernel knows endpoints,
krefs, cranks, and signatures. Mapping a party identifier to a legal name, or
deciding that a given chain assigns liability to a given party, is the host
application's or the organization's job. The kernel's output is evidence.

## Record model

### Always-on identifiers

Two additions to in-flight state, and one persistent counter.

- **Crank number.** A persistent monotonic counter in the kernel store,
  incremented by `startCrank`. SwingSet, from which this kernel is largely
  derived, has this as `crankNumber`, and the same name is used here so that
  anyone reading the two bodies of code side by side finds the same thing
  under it. It has uses beyond accountability and is worth adding on its own.
- **Sender on sends.** `RunQueueItemSend` gains `sender: EndpointId | 'kernel'`.
  `VatSyscall` supplies its `vatId`, the remote receive path supplies the
  `RemoteId`, and `enqueueMessage` supplies `'kernel'`. The run queue is
  persisted as JSON, so the field is a compatible extension.
- **Cause on sends.** `RunQueueItemSend` gains `cause: CrankNumber | 'async'`.
  A send issued during a crank names that crank; a send issued outside any
  crank, which is how a vat's asynchronous activity such as a `fetch` callback
  reaches the kernel, is `'async'`. The kernel cannot see what a vat does
  between deliveries, and the record should say so rather than guess.
- **Trace context on sends and notifies.** An optional
  `trace: { id, hop, hopLimit }`, described under [Traces](#traces). Absent on
  untraced work, which is nearly all work.

The store exposes the current delivery's context to the translators
(`ctx.currentDelivery`, set by `KernelRouter` as it delivers, since a notify can
carry several promises each settled by someone else) so that an introduction
can be stamped with the crank and sender that carried it. The sender of a
notify is the promise's resolver, which the kernel promise keeps once settled;
a late subscription is notified of a resolution made cranks earlier.

### Witness

Every durable record carries `witness: 'kernel' | 'liveslots' | 'vat'`,
naming the layer that vouches for it. A kernel-witnessed record describes
something the kernel observed on its own paths. A liveslots-witnessed record
describes something observed inside the vat process by code that is part of
the kernel's trusted computing base but runs where the vat could, in
principle, have interfered with it. A vat-witnessed record is the vat's own
assertion, worth what the vat's implementer and operator are worth. The three
share one table and one query interface so that a chain can be read as a
whole, and the field is what keeps a reader from mistaking a self-report for
an observation. The records defined below are kernel-witnessed unless they say
otherwise.

### Introductions

An introduction is recorded whenever `translateRefKtoE` allocates a new c-list
entry for an object (not a promise) in an endpoint:

```
introduction {
  kref, endpoint,             // the endpoint's first acquisition of this object
  crankNumber, sender,        // the delivery that carried it
  via: 'message' | 'notify' | 'ocap-url' | 'unknown'
}
```

Bootstrap is not a case of its own: the references a subcluster's vats are
handed at launch arrive in the bootstrap message, sent by `'kernel'`. `'unknown'`
is for a path that hands out a reference without saying how, which no path the
kernel has does; it exists so that such a path, added later, leaves a record
rather than killing the run loop.

This is the first conveyance of a reference into an endpoint and nothing more:
later conveyances of the same reference to the same endpoint, by other
senders along other paths, are not introductions and are recorded only when
something below asks for them. What the introduction gives is a known first
hop for every reference every endpoint holds, at one small write per c-list
allocation, the same cardinality as the c-list itself. That is cheap enough to
be on by default under a kernel option, and it is what lets an object be
tracked after the fact and still have a chain of custody behind it, if a
partial one. A kref re-imported after its c-list entry was retired gets a
fresh introduction, which is correct: the endpoint acquired it anew.

`via: 'ocap-url'` marks the one acquisition the kernel sees without a sender.
Redemption of an ocap URL is unattributed by construction, since the URL is a
bearer token. The record names the redeeming remote and the issuing crank
(`retainForOcapURL` runs in one), and the issuing vat is answerable for having
minted a bearer form of the authority.

Object creation needs no separate record. `initKernelObject` already stores
the owner; it gains the creating `crankNumber`.

### Tracked objects

The receiver-side opt-in. A vat holding a reference asks the kernel to record
every exercise of it and every conveyance of it, in this kernel. An exercise
is a delivery whose target is the tracked object:

```
delivery {
  crankNumber, traceId?, hop?,
  target: kref, targetEndpoint,
  sender, cause,
  method,                     // extracted from methargs; args are not recorded
  slots: kref[],              // references conveyed by this message
  result: kpid | null,
  wallClock                   // kernel-side; vats have no trustworthy clock
}
```

A conveyance is any delivery or notify whose slots contain the tracked
object, whatever the target, a kernel service included: handing an object to
the kernel's ocap URL issuer, say, is a conveyance worth recording.

```
conveyance {
  crankNumber, traceId?, hop?,
  kref,                       // the tracked object
  sender, to: endpoint,       // who conveyed it, to whom
  via: 'message' | 'notify',
  carrier: kref | kpid        // the message target or the resolved promise
}
```

The router already walks every slot of every delivery and resolution to
translate it; checking each against the tracked set is a lookup on a path
that is doing more expensive work, and writes happen only on a hit. A
conveyance record is written for each tracked slot, so a message carrying the
same reference in three places yields one record, and one carrying two
tracked references yields two.

Arguments are not recorded by default. They are the bulk of the bytes, they
are the private content of the interaction, and the slots they carry are
already captured. An option on `track` records them for the cases that need
it, and only the owner may ask for it: the arguments are what other holders
say to the object, and the owner is the one party already entitled to hear
them.

Tracking is per kernel: each kernel records what it sees. Any holder may track
a reference, since the cost falls on the holder's own kernel, and a tracked
reference stays tracked until the last holder in that kernel untracks it.
Tracking pins the object for that long: the owner's own export counts for
nothing in the kernel's reference counts, so an object nobody else holds would
otherwise be collected and get a new kref the next time it was exported, under
which it is not tracked. The pin lasts no longer than the trackers and the
owner: a terminated vat's tracking is withdrawn with the rest of its state,
and an object orphaned by its owner's termination is untracked so that it can
be retired, since nothing can be delivered to it any more. The records
themselves stay either way. The owner can track its own exports in the same
way. I would expect that to be the usual case, since the owner is the party answerable
for what the object does and has the most reason to want a record of who
exercised it. A service vat, for example, would track the facet through which it
accepts the requests it bills for, so that every billable request has a record
naming the caller.

### Traces

The initiator-side opt-in, and the mechanism that records what a tracked step
went on to cause rather than just the step itself. A trace is arranged before
the fact and records after it: asking for one says nothing about what an act
will or might cause, only that whatever it did cause, up to the hop limit, is to
be recorded. A trace starts at a root act and propagates causally: every send
issued in a crank that is processing a traced delivery inherits the trace with
`hop + 1`; a resolution issued in such a crank marks the kernel promise, and the
notifies it produces carry the trace onward. Every delivery and notify that
carries a trace is recorded as a `delivery` or `resolution` record, and a
conveyance on a traced delivery or notify names the trace too. The trace
stops when `hop` reaches its limit, which defaults to 8, is set when the
trace starts, and travels with the trace.

```
resolution {
  crankNumber, traceId, hop,
  kpid, endpoint,             // the settled promise, and who is told of it
  sender,                     // who settled it
  rejected, slots
}
```

Roots are:

- a delivery to a tracked object whose tracker asked for `trace`, so that
  whatever the object went on to do in response, and whatever that caused in
  turn, is recorded along with the delivery itself;
- a host call to `queueMessage` that asks for one, so an external act by a
  party is traced through everything it causes;
- later, a vat's explicit request for one of its own outgoing sends, which
  needs a syscall extension and is deferred.

Cost is proportional to the causal footprint of the traced act, bounded by
the hop limit, and zero for everything else. An implementer who judges that the
economics justify it can have a whole operation recorded end to end, while an
unrelated vat on the same kernel pays nothing.

A trace crosses kernels. The trace context rides in the remote message
envelope as an optional field; a peer that does not understand it ignores it,
and the chain is recorded as far as it got. A peer that does understand it
keeps counting from where the trace was. A notify to a peer carries one trace,
so settled promises on different traces go to a peer in separate notifies.

A trace context from a peer is held to what a local tracker could ask for: a
hop limit of at most 64, a hop below it, and an id of the form the kernel
mints. One outside those bounds is dropped as if the peer had sent none. A
peer may carry on a trace this kernel has already recorded only if the trace
reached the peer from here, which is to say a local record on the trace names
the peer; otherwise the delivery is taken as untraced. A peer that learned a
trace id some other way can thus neither pollute the trace nor put an
endpoint of its choosing in a position to read it. A trace that went out
through one peer and comes back through another is cut at the return, and
recorded as far as it got.

Any holder may ask to trace, since a holder tracing what its own calls cause
is tracing its own acts. The records a trace leaves are visible to every
endpoint that appears in them: `trace(traceId)` returns the whole trace to an
endpoint one of its records names, and nothing to any other. A holder who
traces an object therefore learns what its owner went on to do in response,
through whichever endpoints that reached, up to the hop limit.

### Attestations

Everything above is about endpoints. Attestations bind endpoints to parties,
and are the only records whose content comes from outside the kernel:

```
attestation {
  kind: 'operator' | 'implementer' | 'intent',
  subject,                    // peerId, bundle hash, or the act's target
  party: PartyRef,
  payload,
  signature,                  // by the party, over the other four fields
  countersignature?           // by the kernel, on an operator attestation
}
```

A party-issued attestation is signed by the party it names, over the
canonical JSON of its kind, subject, party and payload. What a kernel issues
in its own name, a `segment` or a `receipt`, is a signed statement of a
different shape, `Signed<payload>`, carrying the kernel's peer ID as signer,
its `incarnationId`, and its signature over the three. The incarnation is
there because a crank number names a delivery only within one incarnation of
one kernel: a database reset under the same key starts the count again.

- **operator**: a party declares itself answerable for a kernel, identified
  by peer ID. Signed by the party's key and countersigned by the kernel's
  Ed25519 identity key, so it proves both consent and possession.
- **implementer**: a party declares itself answerable for a bundle,
  identified by content hash. This is the "whoever designed the realizing
  logic" party of the problem statement, and it is distinct from the operator
  of the vat that runs it. The `ValidationCertificate` type in
  `service-discovery-types` is already this shape.
- **intent**: a party's signed statement that it meant a particular act, passed
  in with the `queueMessage` that performs it. See
  [Acts by parties](#acts-by-parties).
- **segment**: a kernel's signed statement of its own chain of custody for a
  kref, attached when a tracked reference is exported to a remote. See
  [Crossing kernels](#crossing-kernels).
- **receipt**: a kernel's signed statement that a particular delivery
  happened, for the receiving vat to hand to whoever needs proof. It carries
  the delivery record, so a receipt for an attributed act carries the intent.

`PartyRef` is an opaque string to the kernel but for its scheme, the part
before the first colon, and this design does not prescribe a scheme. Any
identifier that names a party and comes with a way to verify that party's
signatures will serve: a DID, a bare public key, an account on some
blockchain. The kernel verifies its own Ed25519 signatures, and those of
`ed25519:<hex public key>` parties. Verifying any other party's signature is
delegated to a verifier the host supplies for the scheme, so the kernel takes
on no dependency on any particular ecosystem. A blockchain account attesting
that it operates a kernel, with the kernel countersigning, is one scheme a
host could support; it is not a default.

The kernel does not resolve a `PartyRef` to a name. That is a registry's job.

### Party resolution

Given the records, resolving the parties behind an endpoint is a lookup:

| Endpoint   | Parties                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| a vat      | the kernel's operator, plus the implementer of the vat's bundle if attested                                                                           |
| a remote   | the operator bound to that kernel, or "unbound" if none; its vats are indistinguishable from outside, so every send from it resolves to that operator |
| `'kernel'` | the operator, or the party the host named in `queueMessage`'s attribution                                                                             |

A chain of custody for a kref held by endpoint X is then: the conveyances of
that kref to X, or failing those its introduction, each naming a sender; the
conveyances to each such sender in turn; and so on back to the owner, each hop
resolved to its parties and the owner resolved to its operator and
implementer. Where only introductions exist the chain has one path and is the
first way each endpoint acquired the reference; where the object was tracked
the chain is a graph, since an endpoint may have been given the same reference
by several senders and each is answerable for having done so. A causal chain
for a traced act is the sequence of `delivery` records sharing its trace id,
ordered by hop.

### Acts by parties

A party never calls the kernel. Some software does it on the party's behalf: a
CLI, a daemon, an OpenClaw plugin, a wallet with a human approving in it. This
is the intermediary the problem statement describes, keeping track of which
ocaps the party holds and giving the party a way to direct their use. To the
kernel that software is the host, and `queueMessage` is where its act enters.
The kernel has no way to know what happened before that call; it can only
record what the host says about it.

Records of such acts exist for two audiences: a counterparty or later auditor
outside the party's domain, who wants evidence that the party is bound by the
act; and the party's own organization, which wants to know which of its
people, or which of their agents, did what. The two audiences need different
things, and the design offers a commitment at each of three scopes.

**A blanket commitment.** The operator attestation is a party's signed
statement that it answers for what a kernel does. It is made once, with the
party's own key, and from then on everything the kernel records about acts
entering through its host is the party's word to anyone outside. For most
business use this is enough: a host blessed by the party's IT department, run
on a machine the party controls, is trusted in the same way the party's other
software is, and a per-act signature from it would say nothing the blanket
commitment does not already say.

**Attribution within the domain.** `onBehalfOf: PartyRef` on `queueMessage` is
the host's assertion of which party, among those the operator answers for,
the act was done for. It costs nothing and needs no cooperation from that
party, and it is worth the host's word, which inside the operator's domain is
usually all that is wanted: the organization trusts its own host to say which
employee's agent made the call. A host serving one party, such as a daemon on
a person's own machine, has little reason to say anything here at all, since
the operator attestation already names that party.

**A per-act commitment.** An `intent` attestation is a party's signed statement
of one act: the target, as a kref or ocap URL, the method, a hash of the
arguments, and a nonce or time, signed with the party's own key and passed in
with the `queueMessage` that performs it. It says more than the blanket
commitment only if the key is held where the host cannot reach it, which
splits the host into a part the party trusts to act and a part that holds the
key and asks: a hardware key, or a wallet app with a human at the approval
prompt. The wallet work in this repository already produces statements of this
shape for delegations. The kernel does not check the intent before delivering;
identity is not the gate. It stores the intent bound to the resulting `delivery`
record, and a `receipt` for that delivery can carry it. This is the right scope
for an act whose value justifies a human at a prompt, and such acts are the
outliers; the design makes them possible without making them the norm.

Seen from outside, the host and the kernel are one thing: the party's
software, on the party's machine, covered together by the operator
attestation. They can be two pieces of software a user runs on the same
computer, and from a counterparty's seat nothing distinguishes them. The
distinction matters inside an organization, where the organization operates
the kernel and an individual runs the host. There the kernel is the
organization's record of what its people's agents did, `onBehalfOf` names the
individual, and a per-act intent is how an act is bound to the individual
rather than to the organization as a whole. That is the governance the
problem statement opens with, and it is where identity re-enters the system
at a boundary rather than everywhere.

An LLM agent acting for a user is the case that makes the scopes concrete.
The agent is not a party; its acts are the user's, and `onBehalfOf` names the
user for all of them under the organization's blanket commitment. Which acts
additionally need the user's signed intent is the intermediary's policy and
not the kernel's: paying a provider might, asking one for a quote need not.
The agent's transcript, the reasoning behind the act, is the host's record and
stays outside the kernel. A host that wants the two joinable later puts a hash
of the transcript position in the attribution, and the kernel stores it as it
stores everything else the host asserts.

## Crossing kernels

A reference conveyed to a remote leaves this kernel's view. The chain has to
either travel with the reference or be fetched later from a kernel that may
be gone, unreachable, or unwilling.

It travels. When a kernel exports a tracked kref to a remote for the first
time, it attaches a **segment**: its own chain of custody for that kref as
far as it knows it, signed with its identity key. If that chain itself begins
with a segment received from an earlier kernel, that segment is included
verbatim, so the receiver holds a list of per-kernel segments back to the
origin. The receiving kernel stores it with the introduction record.

Verification is local: peer IDs are hashes of public keys, so each segment
checks against the peer ID it claims. What cannot be checked is omission. A
kernel can present a reference with no segment, or a segment that starts with
itself. The principle above handles this: the chain then begins with that
kernel's party, and that is who is answerable. A party who wants to pass
responsibility upstream has every incentive to keep the segments it was
given.

The alternative, a provenance query service that peers call to fetch chains
on demand, was considered and rejected for the first design. It needs the
upstream kernel to be reachable at query time, needs an authorization story
for who may ask about what, and still cannot prevent the upstream kernel
from lying. Carrying segments costs bytes only on first export of tracked
references, which is rare.

## Inside the vat

A reference employed within a vat never leaves the kernel's view in the sense
of the previous section; it was never in it. Two layers exist below the
kernel, and they can see different things.

**Liveslots** runs in the vat process and is part of the kernel's trusted
computing base. It dispatches each delivery to the exported object that is its
target, and it translates every slot of every outgoing send, both of which
the kernel already knows from its own side. What only liveslots sees is
narrower than one might hope:

- **Durable-kind state.** When a durable object is created or its state is
  written, liveslots serializes the state and sees every reference in it. That
  is an incorporation, recorded as `incorporation { object: vref, slots,
  crankNumber }` with `witness: 'liveslots'`, and it is the only form of
  incorporation anything can observe. Incorporation into a virtual or
  ephemeral object, or by closure, remains invisible.
- **Asynchronous continuations.** The vat's `setTimeout`, `setInterval`, and
  `fetch` are attenuated endowments the kernel supplies, so liveslots can
  carry the delivery context of the crank that scheduled a callback into the
  callback's execution. A send issued from that callback then has a real
  `cause` rather than `'async'`, and inherits the scheduling delivery's trace.
  This is the one place a liveslots layer improves a kernel-witnessed record
  rather than adding a weaker one: the cause it supplies is the kernel's own
  delivery, and the kernel can check that the named crank did deliver to that
  vat.

What liveslots does not see is a direct method call from one of the vat's
objects to another, or a reference captured in a closure, and no
instrumentation short of taint tracking would. The causal pathway through a
vat between a delivery and the sends it produces is not something liveslots
can report, only something it can bracket.

**A support library**, imported by vat code and outside the trusted computing
base, is the only way to account at object granularity within a vat. An
`accountable(exo)` wrapper records each method invocation on the wrapped
object as an `exercise`, stamped with the current delivery context, and a
`convey(ref, to)` helper records a hand-off the developer chooses to declare.
These are `witness: 'vat'` records, written through the accountability
service into the same table as everything else. They cover exactly the
objects a developer wrapped and the hand-offs a developer declared, and they
are the vat's own word. A receipt or a cross-kernel segment never includes
them; `history` and `trace` return them, marked.

The vat's own word is not nothing, though. The kernel records who vouched for
the bundle the vat runs, through the implementer attestation on its content
hash, and who allowed it into the system, through the operator attestation. An
organization that regards that code as trustworthy, and as not subject to the
whims of whichever user happens to be driving the host at the time, can as a
matter of policy accord its vat-witnessed records a corresponding degree of
trust: an honest account of what happened inside the vat, to the extent the
code producing the account is itself trusted. The witness field does not
settle that question; it tells the reader which question to ask, and the
attestations give the reader what is needed to answer it. For an organization
that deploys the support library in its own vetted vats, this is the chief
source of value in having it: object-level accounting whose reliability rests
on code the organization has already chosen to stand behind.

Neither layer changes the unit of kernel attribution. A developer who needs
kernel-witnessed accountability finer than a vat has one tool for it, and it
is the one the capability model has always offered: put the thing that must be
separately answerable in a separate vat. Vats are the kernel's isolation
boundary, and an isolation boundary is an accountability boundary. The layers
above make the inside of a vat legible to its own implementer and operator;
they do not make it legible to anyone else.

## Affordances

### Kernel service

Requested like any other service, `services: ['accountability']`:

| Method                                | Does                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `track(obj, { recordArgs?, trace? })` | start recording deliveries to and conveyances of `obj` in this kernel; with `trace`, also start a trace from each delivery to `obj`, bounded by `trace.hopLimit` (see [Traces](#traces)) |
| `untrack(obj)`                        | stop                                                                                                                                                                                     |
| `history(obj)`                        | this endpoint's records about `obj`: the owner sees every record; another holder sees only its own chain of custody and the deliveries it sent                                           |
| `chain(obj)`                          | the caller's chain of custody for `obj`, including any cross-kernel segments, with each hop resolved to parties                                                                          |
| `trace(traceId)`                      | the records of a trace this endpoint took part in                                                                                                                                        |
| `receipt()`                           | a signed receipt for the delivery the caller is handling, which the kernel knows from the call's `cause`                                                                                 |

The visibility rule on `history` is the one place this design has to make an
access decision, and it follows the reference graph: holding a reference
entitles you to know how you got it and what you did with it, not to a list
of everyone else who holds it. The owner exported it and sees all of it.

The service learns who is calling from the kernel, not from the caller: a
kernel service registered with `withCaller` has each method called with
`{ caller, cause }`, the sending endpoint as the router saw it and the crank
the call was sent in, ahead of the caller's own arguments. `receipt()` is
what the `cause` is for: it finds the delivery record the kernel wrote in that
crank for that endpoint, and refuses a call made outside a delivery, or for a
delivery that left no record, which it does unless its target was tracked or
the host attributed it. `chain()` walks the conveyances of the object to the
caller, or failing those its introduction, and the same for each sender in
turn, back to the owner; each holder is resolved to its parties by the
attestations the kernel holds: for a vat, the operator of this kernel and the
implementer of the vat's bundle; for a remote, the operator of that kernel.

### Delivery context

A vat that wants a receipt for the call it is handling has to be able to
name that call, and it cannot, because the crank number that names a delivery
in the records means nothing outside the kernel that made it. The kernel
names the delivery for it. Every send a vat issues during a delivery carries
that delivery's crank as its `cause`, so when `receipt()` arrives at the
service, the kernel already knows which delivery the vat was handling. The
same goes for the sender: a vat that wants attribution asks the service,
which is asynchronous and keeps attribution in the record-keeping path rather
than on the fast path where it would invite use as an access check.

The supervisor, which is kernel code, will be told the crank it is
delivering in once liveslots carries that through the vat's asynchronous
endowments, so a callback scheduled during a delivery is charged to it. Vat
code sees none of it. A crank number handed to a vat would be an attractive nuisance:
the vat would be tempted to pass it on to a remote party as the name of a
call, which it is not.

### Host and operator

- `Kernel.make(…, { accountability: { recordIntroductions?, operator?, partySignatureVerifiers? } })`
  turns the always-on records off for hosts that do not want them, installs
  the operator attestation once the run loop is up, and supplies verifiers for
  the party schemes the host supports.
- `kernel.queueMessage(target, method, args, { onBehalfOf, intent, trace })`
  lets the host attribute an external act to a party, attach the party's
  signed intent, and start a trace from it. An attributed send is recorded
  as a delivery whether or not its target is tracked, with the attribution
  on the record; an intent of another kind, or whose signature does not
  check, is refused before anything is queued. The kernel does not check that
  the intent matches the act: what the party signed is for the auditor to
  compare, and since nothing ties an intent to one send, a verifier of a
  receipt compares the intent's subject, and any nonce in its payload, with
  the act itself. The facet handed to system vats takes no attribution.
- `kernel.attest(attestation)` stores an implementer or operator attestation
  once its signature checks, countersigning an operator attestation for this
  kernel and requiring the countersignature on one for another;
  `kernel.getAttestations(filter)` reads them back.
- `kernel.exportAccountabilityRecords(filter)` and `kernel.pruneAccountabilityRecords(filter)` are the
  retention operations. Export produces a signed bundle of the filter, the
  records it selected and the attestations, which stands on its own; prune is
  the only thing that deletes records, and it is never implicit.
- `kernel.getVatBundleHash(vatId)` is the bundle hash below.

### Bundle identity

Implementer attestations need something to bind to. The supervisor hashes
each bundle as it fetches it, SHA-256 over the bytes, and reports the hash in
its `initVat` reply; the kernel keeps it under the vat's prefix in the store,
so that a vat can be asked what code it is running and the answer matched
against an attestation. This is useful on its own and is a prerequisite for the
`validatedClient` contact model already sketched in
`service-discovery-types`. The hash is computed in the vat's process, before
the bundle is loaded, by code the bundle cannot reach; it is as trustworthy
as the supervisor, which is the kernel's own code running there.

## Tradeoffs considered

**Vat granularity.** The kernel attributes to vats and nothing finer, and
[Inside the vat](#inside-the-vat) argues that liveslots can add only two
things to that and a library only self-reports. The alternative, making
liveslots instrument every local call and closure, is taint tracking, which
is a research project with a runtime cost the problem statement rules out.
The design instead makes the trust level of every record explicit through the
witness field and leaves finer kernel-witnessed attribution to vat
decomposition.

**Always-on introductions versus opt-in.** Recording every conveyance
unconditionally is the log-everything cost and is rejected. Recording none
until an object is tracked would lose the chain for anything tracked after it
was conveyed, which is the normal case: one tracks an object once it matters.
Introductions sit between: one write per c-list allocation, on a path that
already does several, buying a known first hop for every reference. A kernel
option turns it off.

**Push versus pull across kernels.** Push, as argued above. Segments are
self-contained evidence and do not depend on anyone being online later.

**Trust in self-reported segments.** Cannot be fixed cryptographically
without a global registry of every conveyance, which would be both infeasible
and a privacy disaster. Resolved by assigning responsibility to the last
documented holder.

**Traces versus logging everything.** Logging everything is the Agoric
slogger model, which is the right tool for debugging a single kernel and the
wrong tool here: the problem statement asks for selected actions at a cost
their implementers choose. Traces propagate selection causally so that the
implementer of the root act does not need to know, or instrument, everything
downstream.

**Attestations in the kv store, not the records table.** Attestations are
declarations about subjects, few, looked up by kind and subject, and
replaceable; records are events, many, append-only, and looked up by kref,
endpoint, and crank. Kept under `attestation.<kind>.<subject>` in the kv
store, and exported alongside the records in the signed bundle, which is
where a reader needs both.

**Party verifiers as a kernel option, not a platform service.** The first
draft had a `verifyPartySignature` platform service. A platform service is
an RPC boundary in the browser runtime, with a method spec, a client and a
server to extend, and the host's verifiers would still have to reach the
server somehow. A function map on `Kernel.make` reaches the kernel wherever
it is constructed, and a platform service can be layered under it for a host
that cannot supply functions there.

**Delivery context in vat code.** Left out. A `vatPowers.deliveryContext()`
was the first design, so a vat could name the call it was handling; the
`cause` on its sends names it better, and keeps a kernel-local number out of
vat code.

**Record storage.** Records go in a dedicated SQLite table rather than the
`kv` table. They are append-only, keyed by sequence number, and queried by
kref, trace, and endpoint; a kv store is the wrong shape for that and the
kernel store already owns the schema. Hash-chaining the rows for tamper
evidence is deferred: the kernel trusts its own store, and exported bundles
are signed, which covers the case where records leave the kernel.

**Party identifier.** Left open. The kernel treats the string as opaque and
delegates verification to host-supplied verifiers per scheme, so it is not tied
to any one ecosystem; a DID, a bare public key, or a blockchain account all fit.
What the kernel does not do is adopt libp2p peer IDs as party identifiers: those
identify kernels, kernels are not accountable, and conflating the two is exactly
the principal-versus-party confusion the problem statement warns against.

**Interaction with narrowing.** A kernel-minted narrowing is the one
incorporation the kernel can see, and the attenuation design already plans a
store table of
`(base, delta)` keyed by kref. That table is an accountability record under
this design, and the kernel `narrow` service, when it exists, writes one. A
chain of custody that passes through a narrowing says so.

**Trace context carries its limit.** `{ id, hop, hopLimit }` rather than
`{ id, hop }` with the limit kept by the kernel that started the trace: the
limit has to be known wherever the next hop is taken, a peer included, and
carrying it settles how a trace counts across kernels, which is from where it
was. A kernel service call keeps its trace the same way: its result is settled
in a later turn, so the trace is taken at the call.

**One trace per notify.** A notify that carries several settled promises
records a resolution for each on its own trace, but the endpoint handles the
batch in one crank, so what it sends in response inherits the first traced
promise's trace. A peer takes a notify's trace for every promise the notify
carries, so a batch is split by trace on the way to a peer rather than let
the two kernels disagree about which promise is on which trace.

**A peer carries on a trace only along the path it took.** The alternative,
taking any well-formed trace context a peer sends, lets a peer that has seen
a trace id graft unrelated work onto the trace and, through the visibility
rule, hand the whole trace to a colluding endpoint. The check costs a filtered
record query per traced inbound delivery, which is rare, and cuts only a
trace that leaves through one peer and returns through another.

**Interaction with revocation and GC.** Neither touches records. A revoked
object's history is the evidence that matters most. Records do not hold
reference counts.

**Rollback.** A record written in a crank that rolls back is rolled back with
it, which is the point of writing inside the savepoint. One consequence: a
delivery that terminated its vat and was rolled back is invisible to
accountability, and visible only to the logger. Accepted; nothing the vat did
in that delivery took effect.

**Asynchronous vat activity.** Until liveslots carries delivery context
through the vat's async endowments, a send issued outside a crank has `cause:
'async'` and breaks the causal chain at that vat. This is honest: the kernel
did not see what caused it. Once liveslots does carry it, the cause is the
scheduling delivery, which the kernel can confirm it made; what stays
unverifiable is only that the callback was the one scheduled then, which is
the liveslots trust level and is marked as such.

## Implementation strategy

Six phases, each independently useful and landable.

**Phase 0: identifiers.** Crank counter in the store; `sender` and `cause` on
`RunQueueItemSend`, set in `VatSyscall`, the remote receive path, and
`enqueueMessage`; `ctx.currentDelivery` set by `KernelQueue`; creating
`crankNumber` on kernel objects. No new tables. Visible effect: the `@@@@`
delivery log lines can say who sent what, which is worth having on its own.

**Phase 1: introductions and tracked objects.** The accountability records table in
`kernel-store`, with the witness column from the start; introduction records
from `translateRefKtoE`; `track`,
`untrack`, `history` on a new `accountability` kernel service; `delivery`
records from `KernelRouter.#deliverSend` for tracked targets and `conveyance`
records from the slot walks in `#deliverSend` and `#deliverNotify` for tracked
slots; `exportAccountabilityRecords` and `pruneAccountabilityRecords` on the kernel. Records resolve to endpoints only; party resolution is Phase 2.

**Phase 2: parties.** Bundle hashing in the supervisor; `operator`,
`implementer`, and `intent` attestations; kernel signing with the identity
key, which `remote-comms` already derives, and the kernel's `incarnationId`
on everything it signs; party signature verifiers keyed by scheme, `ed25519`
built in and the rest supplied by the host; `onBehalfOf` and `intent` on
`queueMessage`; `chain` and `receipt` on the service, and `cause` in the call
context the kernel gives a service.

**Phase 3: traces.** Trace context on sends and notifies; propagation
through `bufferCrankOutput` and `resolvePromises`; the `trace` option on
`track`; `trace` on the service and on `queueMessage`; the envelope field in the
remote message format.

**Phase 4: segments.** Segment attestations attached on first export of a
tracked kref to a remote, stored on import; `chain` extended to walk them.
This is the first phase that changes what crosses the wire beyond an optional
envelope field, and it comes after the single-kernel design has been
exercised.

**Phase 5: inside the vat.** The crank number on the `deliver` command, and
carried through the attenuated `setTimeout`, `setInterval`, and `fetch`
endowments in `endowments.ts`, so that `cause: 'async'` becomes the
scheduling delivery; `incorporation` records from durable-kind state
writes in liveslots, reported through a syscall; the `accountable` wrapper
and `convey` helper in `kernel-utils`, writing vat-witnessed records through
the service; `history` and `trace` returning records of every witness, and
`chain`, `receipt`, and segments restricted to kernel-witnessed ones. Last
because everything it adds is below the trust level of everything before it,
and the kernel-witnessed design should be shown to carry its weight first.

Each phase ends with its records visible in `kernel-ui`, since a provenance
chain nobody can look at is not evidence. The orchestration demo is the
natural first consumer: a service vat tracks the facet it charges for, the
agent's acts are attributed to the inventor's party identifier through
`onBehalfOf`, and the receipts become the input to the reputation service rather
than a hardcoded table.

## Open questions

- Whether introductions should also be written for promises. Promises are
  conveyed too, and a promise that resolves to an object is a conveyance of
  that object, which the notify path handles. The draft says objects only.
- Whether the liveslots layer belongs in liveslots proper, which is imported
  from `@agoric/swingset-liveslots`, or in the supervisor and endowments that
  wrap it, which this repository owns. The async-context part lives naturally
  in `endowments.ts`; the durable-state part does not, and carrying a patch
  against upstream liveslots has a maintenance cost.
- Whether vat-witnessed records should ever be admissible beyond `history`
  and `trace`, for instance in a receipt a vat issues about its own internals
  to a counterparty who has decided to trust that vat's implementer.
- Retention defaults. Nothing above prunes automatically, which is the safe
  default and will surprise someone with a full disk.
