# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `IOListener`, an endpoint peers connect to that yields one `IOChannel` per connection via `accept()`, replacing the previous one-client-at-a-time channel. Each accepted connection is a distinct object, so holding one conveys no way to reach another, and `direction` is enforced per connection. `accept()` resolves `null` once the listener is closed so an accept loop can terminate rather than hang ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
- Anonymous kernel-hosted objects are recorded persistently and swept at kernel init, so one abandoned by a previous incarnation is not left pinned forever, accumulating with every restart — an anonymous object has no name to be re-registered under on boot, unlike a named service. The sweep unpins but cannot delete an object a vat import or queued message still references, so it does not by itself make a delivery to a survivor safe; the `invokeKernelService` fix below is what does ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
- Add `KernelServiceManager.registerAnonymousKernelObject()` / `releaseAnonymousKernelObject()`, which make a kernel-hosted object routable by kref without entering it in the service-name index, so it has no name in the global service namespace and cannot be requested via a cluster config's `services` list. Used to host accepted IO connections, whose authority comes from holding the reference ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
- Report run loop health in `KernelStatus.runLoop` (`{ state: 'idle' | 'running' }` or `{ state: 'failed', error, detail }`), exporting `RunLoopStatus`, `RunLoopStatusStruct`, and `OnRunLoopFailure` ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - `idle` means never started; a loop parked on an empty queue reports `running`
  - `error` is the failure's message and `detail` its whole cause chain, because only strings cross the wire: when a crank dies and its rollback then fails, the message names the rollback and only the chain names what killed the kernel
  - **BREAKING:** `runLoop` is required, so `KernelStatus` gains a mandatory property and a `getStatus` reply from a kernel built before this field fails result validation outright. It cannot be made optional: `exactOptional` would leave the type and the validator disagreeing inside a `type()`, and `optional` widens the property to `| undefined`, which an RPC result may not be
- Add `onRunLoopFailure` to `Kernel.make` options, called with the error that killed the run loop so an embedder that outlives the kernel can exit or restart ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
- Launch all vats in a subcluster concurrently during `launchSubcluster`, reducing startup latency from serial to parallel; failed peer vats receive a rejected kernel promise observable via `E(roots.peer).method()` pipelining ([#983](https://github.com/MetaMask/ocap-kernel/pull/983))
- Add `fetch`, `Request`, `Headers`, and `Response` to available vat endowments ([#942](https://github.com/MetaMask/ocap-kernel/pull/942))
  - Add `VatConfig.network: { allowedHosts: string[] }`; requesting `'fetch'` without it rejects `initVat`
- Integrate Snaps attenuated endowment factories into vat globals ([#937](https://github.com/MetaMask/ocap-kernel/pull/937))
  - Add `setInterval`, `clearInterval`, `crypto`, `SubtleCrypto`, and `Math` (crypto-backed `Math.random`) to the default vat endowments
  - **BREAKING:** `setTimeout` now enforces a 10 ms minimum delay (upstream Snaps `MINIMUM_TIMEOUT`); shorter delays are silently coerced to 10 ms
  - **BREAKING:** `Date.now()` is attenuated — each read adds up to 1 ms of random jitter, clamped monotonic non-decreasing; precise sub-millisecond timing no longer leaks through
  - **BREAKING:** `clearTimeout`/`clearInterval` only clear handles created by the same vat's `setTimeout`/`setInterval`; passing a host-format handle is a no-op
  - **BREAKING:** replace exported `DEFAULT_ALLOWED_GLOBALS` constant with `createDefaultEndowments()` factory and `VatEndowments` type; `VatSupervisor` now accepts `makeAllowedGlobals` in place of `allowedGlobals`
- Make vat global allowlist configurable and expand available endowments ([#933](https://github.com/MetaMask/ocap-kernel/pull/933))
  - Export `DEFAULT_ALLOWED_GLOBALS` with `URL`, `URLSearchParams`, `atob`, `btoa`, `AbortController`, and `AbortSignal` in addition to the existing globals
  - Accept optional `allowedGlobals` on `VatSupervisor` for custom allowlists
  - Log a warning when a vat requests an unknown global
- Export `OcapURLIssuerService` and `OcapURLRedemptionService` types so vats can type the corresponding kernel-service endowments ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))
- Reference-marker sigil (`@@NAME`) at the `queueMessage` RPC boundary lets JSON-RPC callers name a live kernel object as a call argument ([#984](https://github.com/MetaMask/ocap-kernel/pull/984))
  - Anywhere in the args tree, a string of the form `@@NAME` (NAME is one or more alphanumeric characters, currently a well-formed kref) is expanded to a `kslot` standin so `kser` encodes it as a real CapData slot in the dispatched message
  - Purely an RPC-boundary concern: internal callers of `Kernel.queueMessage` are unaffected
  - Caveat: a legitimate string argument that begins with `@@` followed by alphanumerics will be misinterpreted as a marker; wrap such literals inside an object
- Reference-count auditing: `auditRefCounts`, `recomputeRefCounts`, `formatRefCountViolations`, `assertRefCountsIfAuditing`, and `setRefCountAuditing` on the kernel store, plus a `Kernel.make` option `auditRefCounts` that verifies every kref's counts against the references the kernel actually holds at the end of each crank ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - Reports drift in both directions: counts too low, which lets a live capability be collected, and counts too high, which keeps a dead one alive. A holder that should have been torn down but wasn't is not detectable this way, since it justifies its own count
  - Only references visible in the kernel's own state are checkable, so a holder that keeps a kref outside them has to take a pin to be counted at all
  - `recomputeRefCounts` is a repair tool for a drifted store, offered to embedders and never run automatically: opening an existing store does not migrate it. Reach it by calling `makeKernelStore` over the kernel's own database
  - Exports the `RefCountViolation` type
- Add `setReachableFlag` to the kernel store, the counterpart to `clearReachableFlag` ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
- Add `getOcapURLObjects`, `getOcapURLIssuanceCount`, `retainForOcapURL`, `undoOcapURLRetention` and `releaseOcapURLRetentions` to the kernel store, and `VatManager.releaseVatRootPin` ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - `undoOcapURLRetention` unwinds one issuance whose URL was never minted; `releaseOcapURLRetentions` drops a target's whole retention, for disavowing every URL naming it at once
- Add `getPinCount` to the kernel store, which reports how many pins are held on an object ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))

### Changed

- **BREAKING:** `Kernel.make`'s `ioChannelFactory` option is now `ioListenerFactory`, and the exported `IOChannelFactory` type is replaced by `IOListener` and `IOListenerFactory`. A cluster config's `io` entries now create listeners; vats call `accept()` to obtain a channel instead of reading and writing the endowment directly ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
- Attribute a failed subcluster vat launch to the specific vat by kernel id and `ClusterConfig` name (e.g. `Failed to launch vat v3 (bob)`), preserving the original error as the `cause` ([#975](https://github.com/MetaMask/ocap-kernel/pull/975))
- **BREAKING:** Remove `VatConfig.platformConfig.fetch` — migrate to `globals: ['fetch', ...]` + `network.allowedHosts` ([#942](https://github.com/MetaMask/ocap-kernel/pull/942))
- **BREAKING:** `MakeAllowedGlobals` now takes a `{ logger }` options bag ([#942](https://github.com/MetaMask/ocap-kernel/pull/942))
- **BREAKING:** Type `VatConfig.globals` and `Kernel.make`'s `allowedGlobalNames` as `AllowedGlobalName[]` (a literal union) instead of `string[]`; unknown names are now rejected at the `initVat` RPC boundary ([#941](https://github.com/MetaMask/ocap-kernel/pull/941))
  - Exports: `AllowedGlobalName`, `AllowedGlobalNameStruct`, `MakeAllowedGlobals`, `VatEndowmentsStruct`
- Bound relay hints in OCAP URLs to a maximum of 3 and cap the relay pool at 20 entries with eviction of oldest non-bootstrap relays ([#929](https://github.com/MetaMask/ocap-kernel/pull/929))
- **BREAKING:** Rename `krefsToExistingErefs` to `krefsToErefs`, which now throws on an unmapped kref instead of silently dropping it ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
- **BREAKING:** `getPinnedObjects` now names each pinned object once, however many pins it holds; `getPinCount` gives the number of pins ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
- **BREAKING:** `incrementRefCount` now throws on a kref the kernel has already deleted, rather than writing a resurrected row ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - A missing object row read as `(0, 0)` and was written back as a live-looking object with no owner; a missing promise row read as `NaN`, which no decrement can bring to zero, so the promise could never be collected. `decrementRefCount` still tolerates a missing object row, since releasing a reference to something already gone is ordinary teardown

### Fixed

- A message delivered to a kernel-owned kref with no registered service now rejects the caller with `ENDPOINT_UNREACHABLE` instead of throwing, which escaped the crank and killed the run loop — turning one unreachable reference into a dead kernel ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
  - Reachable without any kernel bug: an anonymous kernel object hosts something that cannot outlive the process, such as an accepted socket connection, so a vat holding one across a restart or a message to one still queued from the previous incarnation lands here. That surviving reference is exactly what stops the init sweep deleting the object, so its `kernel` owner survives with it
  - Matches what `KernelRouter` already does for a delivery whose endpoint has vanished. A message sent with no result promise has nobody to report to, so it is logged instead
- The kernel run queue no longer strands messages, going quiet with no error, no log, and no crash. `runQueueLengthCache` uses a negative value to mean "unknown, re-read from the database", but `enqueueRun`/`dequeueRun` adjusted it arithmetically without materializing it first — so an enqueue while the cache held `-1` produced `0` for a queue that actually held an item, and because `0` is not negative it was never re-read again. The run loop then saw an empty queue, went to sleep, and stranded everything behind it. Two paths reach that `-1`: kernel startup, and `rollbackCrank`, which invalidates the cache because a rollback may have restored dequeued items. The rollback path is the more likely of the two in practice, since a rollback is normally followed immediately by enqueueing an error or termination message. The run loop is also now woken by any non-empty queue rather than only by the empty-to-one transition, so a drifted count cannot silently lose the wakeup either ([#1007](https://github.com/MetaMask/ocap-kernel/pull/1007))
- Stop reporting a healthy kernel after the run loop dies ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - The error was logged and swallowed, so `getStatus` kept returning its healthy-looking record while nothing on the run queue was processed and every `queueMessage` hung forever. Results in flight now reject with the killing error as their `cause`, later calls reject immediately, and `getStatus` answers without waiting on a crank that may never end
- Roll back the crank the run loop died in instead of committing it, so a restart resumes from a consistent boundary ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - Because the killing item is no longer consumed, a restart re-dequeues it; an item that reliably kills a crank needs `clearState`/`reset` rather than a restart
  - Store state only — a crank that had already flushed its buffer settled JS-side subscriptions irreversibly
- Keep a crank's store work inside one transaction, so terminating the vat and collecting garbage after an aborted delivery are committed with the crank instead of autocommitting a statement at a time ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
  - Buffered vat outputs are flushed after that work rather than before it, so a later failure can no longer roll the crank back underneath an answer already given. Termination still settles the dying vat's own promises immediately
- `rollbackCrank` now also reverts the state a database rollback cannot reach, whether or not the rollback itself succeeded: cached stored values are re-read, and the crank's accumulated garbage-collection candidates are discarded ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
  - Otherwise a cache kept the abandoned crank's value and the next write persisted it, a GC action taken out of the set for an aborted delivery was lost rather than retried, and a later `collectGarbage` killed the run loop on a promise the rollback had deleted
- Cleanup after a dead crank no longer replaces the error that killed the run loop: a failing `endCrank` reports it as `cause`, and neither `endCrank` nor `rollbackCrank` retries a savepoint that a failed rollback or release has already discarded ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
- A failing savepoint rollback in `RemoteHandle.handleRemoteMessage` and `RemoteManager`'s incarnation change is logged rather than thrown, so the failure it was cleaning up after is what reaches the caller ([#1021](https://github.com/MetaMask/ocap-kernel/pull/1021))
- Refuse inbound remote deliveries once the run loop is dead, rolling back without acknowledging them, so the peer retries and gives up instead of waiting on a kernel that will never deliver ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - Covers `bringOutYourDead` as well as `message` and `notify`: a reap is queue work too, consumed only by the run loop. The remaining GC arms need no guard, since they only touch refcounts
- Refuse `launchSubcluster` once the run loop is dead ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - The bootstrap message can't be queued either way, but the launch reached that point having already spawned a vat worker per entry in the config, none of which its cleanup path tears down
- Keep crank bookkeeping consistent when the database misbehaves: `endCrank` settles its `waitForCrank` waiters even if releasing savepoints throws (previously stranding `getStatus`, `stop`, `reset`, `clearStorage`, and the `VatManager`/`SubclusterManager` waiters), `rollbackCrank` forgets its savepoint even if the rollback throws (which otherwise had `endCrank` commit the crank being abandoned), and `createCrankSavepoint` records a name only once the database created it ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
- Report the database error when an aborted crank cannot be rolled back, instead of a spurious "no such savepoint" ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
  - The abort path recorded the rollback only after it succeeded, so a throwing rollback had the run loop try again against the savepoint `rollbackCrank` had already discarded. The second attempt's "no such savepoint" then became the reported cause of death — and since only `error.message` crosses the wire, the real failure reached neither `getStatus` nor the daemon log
- Reject the run loop's promise with the same `Error` its status reports, rather than re-throwing a non-`Error` for the embedder to normalize a second time ([#1005](https://github.com/MetaMask/ocap-kernel/pull/1005))
- **BREAKING:** Make c-list reference accounting symmetric: creating an import c-list entry now takes a reference, as tearing one down has always released one ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - `initKernelObject` now births objects at `(0, 0)` instead of `(1, 1)`. The old constant made the arithmetic come out right for exactly one importer, masking the missing increment; with two importers a live capability could be dropped and retired out from under a holder
  - Removes the owner-side baseline decrements in `cleanupTerminatedVat` and `forgetEndpointImports`, which double-claimed the same unit an importer's drop also spent — the source of `"koNN" underflow -1,0` escaping mid-cleanup and leaving a vat half-cleaned
  - `translateRefKtoE` now re-establishes reachability, so a vat handed an object it previously dropped is counted as holding it live again
  - **A store written by an earlier version must be reset.** There is no migration: every object in it is still at `(1, 1)` and no vat root is pinned, so the second importer's `dropImports` underflows mid-crank and the last importer's drop can retire a live vat's root. Pins also moved from a single `pinnedObjects` row to a count per object at `pinned.${kref}`, and the old row is no longer read by anything — so every pin in such a store is silently lost on open while the refcount unit each one took remains. `recomputeRefCounts` can rebuild the counts, but not the pins, so it is a diagnostic rather than an upgrade path
- Pin vat root objects for the lifetime of their vat, and release the pin on termination ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - A root is addressable while its vat lives whether or not anyone imports it; the old `(1, 1)` birth baseline was standing in for this
- Garbage-collection action delivery now moves the kernel's own c-list: `dropExports` clears the owner's reachable flag and `retireExports`/`retireImports` tear the entry down ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - Previously the owner's flag never cleared, so the same action could be re-derived, and retired entries outlived the objects they named
- Charge a delivered message's target reference against the run-queue item's own target rather than the routed target, so a message routed through a resolved promise no longer decrements an object nobody charged while leaking the promise ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
- Release a queued notification's reference before the paths that decide there is nothing to deliver, and stop decrementing references on promises retired alongside it that nobody had taken ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
- Transfer, rather than duplicate, the references a message carries when it is queued on an unresolved promise and later re-enqueued on resolution ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
- Fix the stale `cle.`/`clk.` key prefixes in `getPromisesByDecider` and `deleteEndpoint`, which no longer matched the `${endpointId}.c.` c-list layout ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - `getPromisesByDecider` matched nothing, so promises a terminating vat or restarting peer was deciding were never rejected
- Issuing an ocap URL now retains its target, so the URL stays redeemable ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - A URL carries its kref inside an encrypted bearer token and nothing else, so the kernel cannot see from its own state that a holder exists. Under the old `(1, 1)` birth baseline nothing exported was ever collectable and this went unnoticed; at `(0, 0)` the target is collected as soon as the message that carried it to the issuer is delivered, and the URL names a dead capability
  - One pin for as long as any URL names the target, and nothing releases it automatically: the token is persistent and unexpiring, so revocation is what kills the capability — though it only stops deliveries, and leaves the target retained. `releaseOcapURLRetentions` drops a target's retention for a caller that is disavowing every URL naming it
  - Issuing a URL for a kref the kernel has already deleted is now refused rather than resurrecting its counts
  - The retention is taken before the token is minted, since minting awaits and a collection crank can run in that window, and unwound again if minting fails. A failed issuance never disturbs the retention a URL minted for the same target alongside it depends on
- Refuse to import a kref the kernel has deleted into an endpoint's c-list ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - `getObjectRefCount` reads a missing entry as `(0, 0)`, so the new entry's own increment wrote it back and resurrected a live-looking object with no owner — deliverable to by nobody, and endorsed by the audit, since the entry is a legitimate holder for exactly the count it finds
- Release a vat's root pin when a subcluster is deleted without its vats having run ([#1020](https://github.com/MetaMask/ocap-kernel/pull/1020))
  - `deleteSubcluster` bypasses `stopVat`, so nothing released the pin `launchVat` took in the incarnation that did run them, leaving the root's count permanently above zero and a pin outstanding on a vat that no longer exists
- Deserialize CapData rejections in `Kernel.queueMessage` so vat errors surface as plain `Error` objects to all callers ([#928](https://github.com/MetaMask/ocap-kernel/pull/928))
- Detect peer restart across receiver state loss so the receiving kernel no longer silently drops a restarted peer's `seq=1` messages ([#948](https://github.com/MetaMask/ocap-kernel/pull/948))
  - Persist the peer's last-observed incarnation and compare it on every successful handshake; on a detected restart, clear the peer's c-list contributions and reject the promises it was deciding before the new incarnation reuses any erefs
- Accept liveslots-allocated durable, virtual, and faceted vrefs (e.g. `o+d10/1`, `o+v3/4:0`) in `isVRef` / `insistERef` / `EndpointMessageStruct` validation ([#949](https://github.com/MetaMask/ocap-kernel/pull/949))
  - Previously the regex only matched plain `[op][+-]N`, so any vat using `defineDurableKind` failed outgoing-send validation and persisted-slot reads
- Regenerate `incarnationId` when `resetStorage=true` clears the rest of kernel state, completing the #948 peer-restart detection on browser/extension kernel reloads ([#950](https://github.com/MetaMask/ocap-kernel/pull/950))
  - The previous except-list preserved `incarnationId` across `resetStorage` wipes, so a restarted sender signalled the same incarnation it had before the wipe and the matching receiver's handshake decided "no restart" — leaving stale `highestReceivedSeq` in place and silently dropping the sender's fresh `seq=1` messages
- Register a new vat with its subcluster before awaiting `runVat`, so a garbage-collection pass during bundle load cannot delete the still-empty subcluster out from under the in-progress vat creation ([#952](https://github.com/MetaMask/ocap-kernel/pull/952))
- Use length-prefixed framing for remote messages so payloads larger than the underlying transport's per-frame cutoff (e.g. `@libp2p/webrtc`'s 16 KB datachannel limit) are reassembled correctly on the receiver ([#957](https://github.com/MetaMask/ocap-kernel/pull/957))
  - Replace `byteStream` with `lpStream` on every remote channel; the byte-oriented stream did not preserve `write()` boundaries, so any message the transport split into multiple frames was parsed from the first frame only, silently dropped without acknowledgement, and the sender retried until giving up after `MAX_RETRIES`
  - Surface receiver-side framing-cap violations (`InvalidDataLengthError`, `InvalidDataLengthLengthError`) as `ResourceLimitError` with `limitType: 'messageSize'` so size errors look the same whether they tripped on the sender's `validateMessageSize` or the receiver's framing decoder
- Restore IO channels for persisted subclusters at kernel init so re-incarnated vats find their IOService references live ([#963](https://github.com/MetaMask/ocap-kernel/pull/963))
  - `SubclusterManager.restorePersistedIOChannels()` walks every persisted subcluster, finds those whose config declares `io`, and re-creates the channels via `IOManager` before `initializeAllVats` runs
  - Without this, any vat that opened an IO channel via `launchSubcluster` lost its channel across `daemon stop` / `daemon start` and silently held a dead IOService reference

### Security

- A vat's `fetch` can no longer reach a host outside its `network.allowedHosts`. The allowlist was checked against one resolution of the vat's input while `fetch` resolved it again (CWE-367), and a redirect from an allowed host to a forbidden one was followed unchecked ([#1026](https://github.com/MetaMask/ocap-kernel/pull/1026))
  - A vat's `redirect: 'follow'`, in `init` or on a `Request`, no longer reaches the hop unchecked; `manual` and `error` behave as asked. A `dispatcher` in `init` is rejected
  - A redirect that keeps the request body now fails when that body cannot be sent again, which includes any `Request` carrying one — pass the body via `init` instead
  - A vat hosted in a browser can no longer follow a redirect at all: the runtime hides the target of a manual redirect, so the hop cannot be checked and the fetch fails instead
  - An `integrity` a vat asks for is checked against the body the chain ends on rather than by `fetch`, which sees one hop at a time and would hold the digest against a redirect body

## [0.7.0]

### Added

- Add various configurable timeouts for remote communications ([#906](https://github.com/MetaMask/ocap-kernel/pull/906))
- Propagate relay hints from redeemed ocap URLs ([#887](https://github.com/MetaMask/ocap-kernel/pull/887))
- Add `allowedWsHosts` parameter to `initializeRemoteComms()` ([#878](https://github.com/MetaMask/ocap-kernel/pull/878))

### Changed

- **BREAKING:** Adopt branded string types for kernel identifiers ([#917](https://github.com/MetaMask/ocap-kernel/pull/917), [#921](https://github.com/MetaMask/ocap-kernel/pull/921))
- Standardize vat-observable kernel errors ([#913](https://github.com/MetaMask/ocap-kernel/pull/913))
- Upgrade libp2p to v3 and improve remote communication reliability ([#900](https://github.com/MetaMask/ocap-kernel/pull/900), [#915](https://github.com/MetaMask/ocap-kernel/pull/915))
- Auto-extract `allowedWsHosts` from plain `ws://` relay multiaddrs in `ConnectionFactory` ([#881](https://github.com/MetaMask/ocap-kernel/pull/881))
- Use `E()` for kernel service invocation to support remote presences as services ([#872](https://github.com/MetaMask/ocap-kernel/pull/872))

### Fixed

- Attempt to reconnect to unreachable relays on startup ([#918](https://github.com/MetaMask/ocap-kernel/pull/918))
- Restore single-delivery guarantee per crank and prevent rollback cache staleness ([#879](https://github.com/MetaMask/ocap-kernel/pull/879))

## [0.6.0]

### Added

- Add `TextEncoder`, `TextDecoder`, `setTimeout`, and `clearTimeout` to vat globals allowlist ([#856](https://github.com/MetaMask/ocap-kernel/pull/856))
- Add `IOManager` and IO kernel service for vat I/O streams ([#840](https://github.com/MetaMask/ocap-kernel/pull/840))
- Add system subclusters and kernel facet service ([#803](https://github.com/MetaMask/ocap-kernel/pull/803))
  - Restrict kernel services to system subclusters only ([#833](https://github.com/MetaMask/ocap-kernel/pull/833))
  - Return generic "no registered kernel service" error for system-only services requested by non-system subclusters ([#838](https://github.com/MetaMask/ocap-kernel/pull/838))
- Buffer vat outputs to make cranks transactional ([#794](https://github.com/MetaMask/ocap-kernel/pull/794))
  - Enqueue async vat syscalls immediately when outside a crank ([#848](https://github.com/MetaMask/ocap-kernel/pull/848))
- Add caplet vat type for lightweight vat configurations ([#753](https://github.com/MetaMask/ocap-kernel/pull/753))
- Add CapTP infrastructure for kernel-to-kernel communication ([#751](https://github.com/MetaMask/ocap-kernel/pull/751))
- Prevent vat endowment names from being overridden ([#619](https://github.com/MetaMask/ocap-kernel/pull/619))
- Add kernel-to-kernel remote communication via libp2p ([#578](https://github.com/MetaMask/ocap-kernel/pull/578))
  - Add `remoteComms` status to `Kernel.getStatus()` output ([#637](https://github.com/MetaMask/ocap-kernel/pull/637))
  - Add `relays` parameter to `initRemoteComms` for configuring relay servers ([#638](https://github.com/MetaMask/ocap-kernel/pull/638))
  - Add location hint support to OCAP URL handling ([#666](https://github.com/MetaMask/ocap-kernel/pull/666))
  - Fix kernel restart with open remote connections ([#677](https://github.com/MetaMask/ocap-kernel/pull/677))
  - Add automatic reconnection with exponential backoff for remote comms ([#678](https://github.com/MetaMask/ocap-kernel/pull/678))
  - Fix remote endpoint initialization to occur during registration rather than construction ([#681](https://github.com/MetaMask/ocap-kernel/pull/681))
  - Fix shutdown handling to properly sequence crank completion, stream closing, and remote comms teardown ([#692](https://github.com/MetaMask/ocap-kernel/pull/692))
  - Fix remote message queueing during connection establishment ([#697](https://github.com/MetaMask/ocap-kernel/pull/697))
  - Add explicit connection management for intentional disconnects ([#699](https://github.com/MetaMask/ocap-kernel/pull/699))
  - Reject pending promises on connection loss ([#706](https://github.com/MetaMask/ocap-kernel/pull/706))
  - Refactor remote location hint handling and add `registerLocationHints` platform service ([#712](https://github.com/MetaMask/ocap-kernel/pull/712))
  - Add timeout handling for remote message sends and URL redemptions ([#713](https://github.com/MetaMask/ocap-kernel/pull/713))
  - Add resource limits for remote communications ([#714](https://github.com/MetaMask/ocap-kernel/pull/714))
  - Add message sequencing and acknowledgment to remote messaging ([#744](https://github.com/MetaMask/ocap-kernel/pull/744))
  - Persist pending messages and sequence state in `RemoteHandle` across restarts ([#760](https://github.com/MetaMask/ocap-kernel/pull/760))
  - Add rate limiting for remote messages and connections ([#776](https://github.com/MetaMask/ocap-kernel/pull/776))
  - Add BIP39 mnemonic support for kernel identity seed recovery ([#780](https://github.com/MetaMask/ocap-kernel/pull/780))
  - Add kernel incarnation detection protocol for identifying peer restarts ([#788](https://github.com/MetaMask/ocap-kernel/pull/788))
  - Add permanent failure detection for reconnection attempts ([#789](https://github.com/MetaMask/ocap-kernel/pull/789))
  - Add incarnation ID infrastructure and handshake module ([#800](https://github.com/MetaMask/ocap-kernel/pull/800))
  - Handle reconnection to restarted peers with incarnation ID detection ([#807](https://github.com/MetaMask/ocap-kernel/pull/807))
  - Complete Ken protocol implementation for reliable remote message delivery ([#811](https://github.com/MetaMask/ocap-kernel/pull/811))
  - Implement distributed garbage collection protocol for remote references ([#814](https://github.com/MetaMask/ocap-kernel/pull/814))
  - Add cross-incarnation wake detection to reset backoffs on peer restart ([#822](https://github.com/MetaMask/ocap-kernel/pull/822))
  - Enable OCAP URL issuance and redemption without active remote comms ([#823](https://github.com/MetaMask/ocap-kernel/pull/823))
  - Add direct transport support (QUIC + TCP) for Node.js peer connections ([#839](https://github.com/MetaMask/ocap-kernel/pull/839))
  - Add `initRemoteComms` and `registerLocationHints` RPC methods for kernel control ([#849](https://github.com/MetaMask/ocap-kernel/pull/849))
  - Fix trailing comma in OCAP URLs when no relays are known ([#850](https://github.com/MetaMask/ocap-kernel/pull/850))
  - Allow plain `ws://` connections for relay dialing ([#855](https://github.com/MetaMask/ocap-kernel/pull/855))
  - Restrict plain `ws://` relay dialing to private and explicitly allowed addresses ([#857](https://github.com/MetaMask/ocap-kernel/pull/857))
  - Accept `allowedWsHosts` parameter in `initRemoteComms` RPC ([#858](https://github.com/MetaMask/ocap-kernel/pull/858))
  - Re-dial relays on connection close with exponential backoff ([#860](https://github.com/MetaMask/ocap-kernel/pull/860))

### Changed

- **BREAKING:** Drop Node 20 support ([#837](https://github.com/MetaMask/ocap-kernel/pull/837))
- Close database in `Kernel.stop()` ([#845](https://github.com/MetaMask/ocap-kernel/pull/845))
- Remove `reloadConfig` and `reloadSubcluster` methods from `Kernel` ([#836](https://github.com/MetaMask/ocap-kernel/pull/836))
- Export `Baggage` and `VatPowers` types ([#801](https://github.com/MetaMask/ocap-kernel/pull/801))
- Load vat bundles via Vite instead of `@endo/import-bundle` ([#763](https://github.com/MetaMask/ocap-kernel/pull/763))
- Extract `VatManager` and `SubclusterManager` from `Kernel` class ([#651](https://github.com/MetaMask/ocap-kernel/pull/651))
  - Extract `RemoteManager` and `KernelServiceManager` from `Kernel` class ([#653](https://github.com/MetaMask/ocap-kernel/pull/653))
- Migrate kernel service dispatch from `Far` to `makeExo` ([#612](https://github.com/MetaMask/ocap-kernel/pull/612))

### Fixed

- Disable cache for default bundle fetch ([#802](https://github.com/MetaMask/ocap-kernel/pull/802))
- Clean up orphan messages during recovery ([#769](https://github.com/MetaMask/ocap-kernel/pull/769))
- Fix message delivery to terminated vats ([#617](https://github.com/MetaMask/ocap-kernel/pull/617))
- Handle messages remaining in queue after kernel restart ([#611](https://github.com/MetaMask/ocap-kernel/pull/611))
- Fix kernel initialization and operation with persistent storage ([#604](https://github.com/MetaMask/ocap-kernel/pull/604))

## [0.5.0]

### Changed

- Dual-license package under MIT and/or Apache 2.0 ([#601](https://github.com/MetaMask/ocap-kernel/pull/601))

## [0.4.0]

### Added

- Add kernel service object support ([#563](https://github.com/MetaMask/ocap-kernel/pull/563))

### Changed

- Wait for crank to run kernel actions ([#595](https://github.com/MetaMask/ocap-kernel/pull/595))
- Bump Endo and Agoric dependencies ([#590](https://github.com/MetaMask/ocap-kernel/pull/590))
- Throw if subcluster launch fails ([#566](https://github.com/MetaMask/ocap-kernel/pull/566))
- Use `@metamask/logger` ([#559](https://github.com/MetaMask/ocap-kernel/pull/559))

### Fixed

- Remove redundant kernel promise ref count increment ([#565](https://github.com/MetaMask/ocap-kernel/pull/565))

## [0.3.0]

### Added

- Add `revoke` kernel command ([#544](https://github.com/MetaMask/ocap-kernel/pull/544))
- Support multiple subclusters ([#530](https://github.com/MetaMask/ocap-kernel/pull/530))

### Removed

- Remove support for launching vats outside a subcluster ([#535](https://github.com/MetaMask/ocap-kernel/pull/535))

### Fixed

- Throwing from remotable method rejects result ([#545](https://github.com/MetaMask/ocap-kernel/pull/545))

## [0.2.0]

### Added

- Make export paths compatible with Browserify ([#533](https://github.com/MetaMask/ocap-kernel/pull/533))
- Properly handle syscall failures ([#520](https://github.com/MetaMask/ocap-kernel/pull/520))
- Add `Kernel.getStatus()` ([#522](https://github.com/MetaMask/ocap-kernel/pull/522))
- Use JSON-RPC notifications for vat syscalls ([#528](https://github.com/MetaMask/ocap-kernel/pull/528))

### Removed

- Remove `waitForSyscallsToComplete()` ([#527](https://github.com/MetaMask/ocap-kernel/pull/527))

## [0.1.0]

### Added

- Initial release.

[Unreleased]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/ocap-kernel@0.7.0...HEAD
[0.7.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/ocap-kernel@0.6.0...@metamask/ocap-kernel@0.7.0
[0.6.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/ocap-kernel@0.5.0...@metamask/ocap-kernel@0.6.0
[0.5.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/ocap-kernel@0.4.0...@metamask/ocap-kernel@0.5.0
[0.4.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/ocap-kernel@0.3.0...@metamask/ocap-kernel@0.4.0
[0.3.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/ocap-kernel@0.2.0...@metamask/ocap-kernel@0.3.0
[0.2.0]: https://github.com/Consensys-Incorporated/ocap-kernel/compare/@metamask/ocap-kernel@0.1.0...@metamask/ocap-kernel@0.2.0
[0.1.0]: https://github.com/Consensys-Incorporated/ocap-kernel/releases/tag/@metamask/ocap-kernel@0.1.0
