# Feasibility: a streaming audio/video chat client on the ocap kernel

This document assesses building a Zoom/Meet-style client where every
participant runs an ocap kernel and receives the audio and video of every
other participant independently (full mesh). It describes what the kernel
offers today, which parts of the application fit it, which parts must stay
outside it, and the kernel changes each design needs.

## Verdict

- **Feasible, with a split design.** The kernel should carry the
  _control_ and _signaling_ planes of a call (rooms, invitations, membership,
  mute/kick, SDP and ICE exchange). The _media_ plane (encoded audio and
  video) must flow over WebRTC media channels owned by the host and exposed to
  vats as capabilities. This fits the kernel's existing patterns and needs a
  moderate set of upgrades, listed below.
- **Not feasible as "media bytes through kernel messages".** Every kernel
  message is a crank: a SQLite transaction, a JSON string, a Ken-style
  persisted and acknowledged send, delivered one at a time by a single run
  loop. Audio alone is 50 packets per second per peer. That design would have
  to replace the message path, the marshal format, the persistence model and
  the vat endowment set. It is a different kernel, not an upgrade.

## What the kernel provides today

Facts from the codebase that bound the design.

**Execution model**

- One run loop takes one item per crank, alternating between the run queue and
  remote arrivals. Each crank is a SQLite transaction (savepoints in
  `kernel-store`; OPFS-backed WASM SQLite in the browser, which is ephemeral
  without OPFS).
- Vats run in their own workers (iframes in the browser, worker threads in
  Node), so vats compute in parallel, but every delivery into a vat is a
  JSON-RPC round trip over a MessagePort or worker stream validated by
  `isJsonRpcMessage`. No transferables, no binary payloads.
- Marshaling is `@endo/marshal` smallcaps. Typed arrays are not passable. Binary
  data crosses vat and kernel boundaries only as strings.

**Remote communication** (`packages/ocap-kernel/src/remotes`)

- libp2p 3 with WebSockets, WebTransport, WebRTC (data channels only) and
  circuit relay v2, Noise encryption, yamux muxing. STUN servers are
  configured; no TURN.
- Messages are JSON strings, length-prefixed, capped at 1 MB, rate limited to
  100 messages per second per peer, with a window of 200 unacknowledged
  messages, a 10 s ACK timeout, 3 retries and a 50 ms delayed ACK.
- Delivery is exactly-once, FIFO, sender-logged: every outbound message is
  written to SQLite before it goes on the wire and deleted only when
  acknowledged (see `docs/ken-protocol-assessment.md`). This is exactly right
  for capability messages and exactly wrong for media.
- Peer identity is an Ed25519 key; objects are shared as `ocap:` URLs with
  relay hints. Reconnection, incarnation handshakes and a wake detector exist.

**Vat endowments and platform capabilities**

- Vats get only the globals they request. `Date.now()` has up to 1 ms of
  jitter and is monotonic-clamped. There is no `performance.now`,
  `requestAnimationFrame`, `AudioContext`, `MediaStream`, `RTCPeerConnection`
  or `getUserMedia`. SES withholds `Float32Array` and `Float64Array` from
  compartments, so vat code cannot hold PCM audio in the usual form.
- Platform capabilities (`packages/kernel-platforms`) are the pattern for host
  resources: `http` and `fs` today. A capability is built inside the vat's own
  worker by `makePlatform`, scoped by `platformConfig`, and can be narrowed by
  the vat before being passed on. The `http` capability is JSON-only
  (`body: string`), so it is a model for the configuration and narrowing
  story, not for a capability that returns live handles.
- In the browser, vats are sandboxed iframes with an opaque origin and a CSP
  of `default-src 'none'; connect-src *`. `getUserMedia` is not available
  there. The kernel runs in a Web Worker inside an extension offscreen
  document (or a page). Media devices and peer connections must live in that
  host document.

**Streaming precedents**

- `@ocap/remote-iterables` and `kernel-test/src/async-generator.test.ts` show
  pull-based async iteration across vats. Each `next()` is a message and a
  crank, so this is for control-rate data, not frames.
- `kernel-test/src/orphaned-ephemeral-exo.test.ts` shows that an exo held
  across a provider restart rejects. This is the behavior a media handle needs.

## Mapping a video call onto the kernel

Three planes, with the kernel in two of them.

### 1. Capability and control plane (fits today)

A `Room` exo in a room-owner vat. Joining is redeeming an `ocap:` URL. Each
participant holds a `Participant` facet; the room holds a facet per member
for mute, hand-raise, kick (revocation) and membership change notifications.
This is ordinary distributed-object code and needs nothing new from the
kernel. Persistence is a bonus: a room and its membership survive a kernel
restart.

### 2. Signaling plane (fits, with care)

WebRTC needs each pair of participants to exchange an SDP offer, an SDP
answer and a handful to a few dozen ICE candidates. These are small, ordered
messages that benefit from exactly-once delivery. They ride as `E()` calls
between participant vats. For a mesh of N participants, call setup is
O(N^2) pairs, each tens of messages, well under the 100 messages per second
per-peer limit and the 1 MB cap. Latency is one crank per hop plus transport,
so setup adds tens of milliseconds, which is acceptable.

Two caveats. The kernel persists every signaling message until acknowledged,
so an ICE storm writes to SQLite; fine at these volumes. And signaling for the
media peer connection is separate from libp2p's own WebRTC transport: the
libp2p `RTCPeerConnection` is internal to `@libp2p/webrtc` and exposes only
data channels, so media cannot share it.

### 3. Media plane (must stay in the host)

Each participant's host document owns `getUserMedia`, one `RTCPeerConnection`
per remote participant, and playback (`<video>` elements or a Web Audio
graph). Vats never see frames. They hold capabilities to tracks and
connections: `addTrack`, `createOffer`, `setRemoteDescription`,
`addIceCandidate`, `mute`, `stop`, plus event subscriptions (`onIceCandidate`,
`onTrack`, `onConnectionStateChange`). This keeps the browser's WebRTC stack
(Opus, VP8/VP9/AV1, SRTP, jitter buffers, packet loss concealment, echo
cancellation, RTCP-based lip sync) doing the real-time work it was built for.

"Every kernel receives every other participant's stream independently" is the
full-mesh topology, and it is what the media plane above gives you. Each
participant uploads N-1 encodes and decodes N-1 streams. In practice this caps
calls at roughly 6 to 8 participants on consumer uplinks and CPUs. Beyond that
you need an SFU, which is a participant that forwards without decoding. A Node
kernel could play that role with a Node WebRTC stack, but then streams are no
longer received "independently" from the origin, and end-to-end encryption
needs insertable streams or SFrame on top.

## Stream synchronization challenges

- **Within one remote participant (lip sync).** WebRTC aligns audio and video
  of the same `MediaStream` using RTCP sender reports. If audio and video came
  through different paths (for example audio via the kernel, video via
  WebRTC) lip sync is lost. Keep both tracks on the same peer connection.
- **Across participants.** There is no global timeline in a mesh call and no
  product needs one; each receiver plays each remote stream at that stream's
  own arrival-minus-jitter-buffer delay. Receiving streams "independently"
  means accepting that two participants hear a third at slightly different
  delays. Recording a synchronized multi-track session is a separate problem
  that needs per-track RTP timestamps and NTP mapping, which the browser does
  not expose to JavaScript today.
- **Clock drift.** Sound card clocks drift by tens of parts per million. The
  WebRTC audio engine resamples to absorb this. Anything done in vat code
  cannot, because vat time is millisecond-jittered `Date` and there is no
  audio clock.
- **If media went through kernel messages.** Delivery is reliable and ordered,
  so one lost packet stalls everything behind it until retransmission. The
  retransmit timer is 10 s. A 20 ms audio frame is 50 sends per second per
  peer, and the rate limiter and the 200-message window would be exhausted in
  seconds under any loss. There is no jitter buffer, no timestamp source
  finer than 1 ms with jitter, and no concealment. Audio through this path
  would be unlistenable, which is the strongest argument for the split
  design.

## Other foreseeable problems

- **Media permissions and extension hosting.** A sandboxed vat iframe cannot
  call `getUserMedia`. In an extension, offscreen documents support
  `USER_MEDIA` and `WEB_RTC` reasons, but the permission prompt must come from
  a visible page. In a web app, the page hosting the kernel worker owns media.
  Either way, media objects live outside the vat realm and need a proxy.
- **NAT traversal.** Only STUN is configured. Symmetric NATs and corporate
  networks will fail without TURN. Any real deployment needs TURN credentials,
  which raises the question of who issues them; a natural answer is a
  capability from the room owner.
- **Restart semantics.** A vat is resuscitated from baggage after a kernel
  restart, but a `RTCPeerConnection` is gone. Media capabilities must be
  explicitly ephemeral: held in memory, not baggage, and invalidated with a
  notification so the vat renegotiates.
- **Run-loop contention.** Signaling cranks share the single run loop with
  everything else the kernel does. A busy kernel (GC reaps, other subclusters)
  delays ICE and slows call setup; it never affects media once connected.
- **Identity, privacy and abuse.** Relays see connection metadata. Invitation
  URLs are bearer tokens and must be single-use or short-lived. Revocation
  exists for kernel objects; revoking a participant must also tear down the
  host-side peer connection, which is a capability-design obligation, not
  automatic.
- **Mobile and background tabs.** Browsers throttle timers in background tabs
  and suspend workers on mobile. The wake detector helps reconnection, but the
  media plane needs its own keepalive and renegotiation.
- **Testing.** There is no media in the current e2e harness. Playwright with
  fake media devices (`--use-fake-device-for-media-stream`) covers the browser
  side; the Node side needs a WebRTC implementation (werift or node-webrtc).

## Kernel upgrades, in order

Each item names the package and the shape of the change. Estimates are
rough engineering weeks for one person familiar with the code.

1. **Host-realm platform capabilities** (`kernel-platforms`,
   `kernel-browser-runtime`). Today `makePlatform` builds capabilities inside
   the vat worker. Media must be built in the host document and proxied into
   the vat over the existing vat stream, with opaque handle ids, method calls
   as JSON-RPC, and host-to-vat events as deliveries. `PlatformServicesServer`
   and `PlatformServicesClient` are the right starting point. This also fixes
   the general problem that vat-side capability promises settle outside any
   crank. 3 to 4 weeks.
2. **A `media` capability** (`kernel-platforms/src/capabilities/media`).
   Config: which device kinds a vat may open, whether it may create peer
   connections, allowed ICE servers. Capability: `getUserMedia`,
   `makePeerConnection`, track and connection handles with the methods listed
   under the media plane above, and narrowing (for example, audio only, or
   receive only). Follow the `http` capability for config structs and
   narrowing. Browser implementation first; Node via werift behind the same
   interface. 3 to 5 weeks for browser, 3 more for Node.
3. **Ephemeral capability semantics** (`ocap-kernel`). A documented and
   kernel-supported way to mark a capability as not surviving restart:
   rejected on resuscitation with a distinguishable error, never stored in
   baggage, and a vat-side notification on invalidation. The orphaned-ephemeral
   test shows the current behavior; this makes it a feature. 1 to 2 weeks.
4. **Event delivery from host to vat** (`ocap-kernel`,
   `kernel-browser-runtime`). ICE candidates, track arrival and connection
   state changes are pushes. Model them as the host enqueuing a kernel message
   to a vat-provided exo, so they are ordinary cranks, persisted and ordered.
   Candidate bursts of dozens per second are fine. 1 to 2 weeks, mostly done
   if item 1 lands cleanly.
5. **TURN and ICE configuration as capability** (`ocap-kernel/remotes`,
   `kernel-platforms`). Let the `media` capability accept an ICE server list
   at narrowing time, and let the room owner hand out TURN credentials as a
   capability. 1 week.
6. **Playback and mixing surface** (`kernel-browser-runtime`, application).
   The vat decides which remote tracks are attached to which output (or to a
   Web Audio mixer for active-speaker gain). This is a capability on the host
   document's UI; keep it narrow (attach track id to sink id). 1 to 2 weeks.
7. **Test infrastructure** (`kernel-test`, `extension`). Fake-device
   Playwright e2e for a two-browser call; Node mesh tests with werift. 2
   weeks.

Not required for the split design, listed because the literal reading of the
request would need them:

- Binary passables (`byteArray`) in marshal and a binary wire encoding
  instead of JSON strings.
- A second class of send: unreliable, unordered, unpersisted, bypassing the
  Ken queue and the per-crank SQLite transaction.
- Transferable `ArrayBuffer` across the vat MessagePort and a stream type in
  `@metamask/streams` that carries them.
- Kernel-brokered raw libp2p streams handed to vats as capabilities, so bulk
  data bypasses the run loop.
- `Float32Array`, `AudioWorklet` and WebCodecs endowments, which SES and the
  sandboxed iframe currently prevent.

Each of these is weeks to months, and together they change what the kernel is.

## Suggested path

1. Prototype the control and signaling planes with no kernel changes: two
   Node kernels, a `Room` exo, SDP and ICE as strings over `E()`, and a
   throwaway host-side WebRTC shim. This validates message volumes and
   latency in a week.
2. Land items 1 and 2 in the browser and ship a two-party call in the
   extension or a page.
3. Add items 3, 4 and 5, then scale the mesh and measure where N-1 encodes
   hit the ceiling.
4. Decide whether an SFU participant on a Node kernel is worth the loss of
   independent reception and the end-to-end encryption work it implies.
