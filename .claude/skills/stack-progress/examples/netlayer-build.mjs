// Worked example: the build script behind the netlayer stack page
// (https://claude.ai/artifact/RJyfX5gVUEzN9UMHcR9PXi). Run from a copy in the
// scratchpad, with the imports pointed back here; it writes next to itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { diagram, node, frame, edge, label, dot } from '../scripts/svg-kit.mjs';

const KIT = new URL('../template.html', import.meta.url);
const template = readFileSync(KIT, 'utf8');
const head = template
  .slice(0, template.indexOf('<div class="wrap">'))
  .replace('{{Two-to-four word title}}', 'Netlayer Stack Progress');
const PR = (n) =>
  `<a href="https://github.com/Consensys-Incorporated/ocap-kernel/pull/${n}">#${n}</a>`;

// One layout; snapshots differ in roles, labels and presence.
function netDiagram(snap, ariaLabel) {
  const A = snap === 'A';
  const D = snap === 'D';
  const parts = [];
  // Frames
  if (A) {
    parts.push(
      frame({
        x: 45,
        y: 118,
        w: 820,
        h: 282,
        role: 'none',
        label: '@metamask/ocap-kernel',
      }),
    );
  } else {
    parts.push(
      frame({
        x: 45,
        y: 118,
        w: 615,
        h: 104,
        role: 'none',
        label: '@metamask/ocap-kernel',
      }),
    );
    parts.push(
      frame({
        x: 45,
        y: 262,
        w: 570,
        h: 138,
        role: 'goal',
        label: '@metamask/netlayer',
      }),
    );
    parts.push(
      frame({
        x: 635,
        y: 262,
        w: 230,
        h: 238,
        role: 'alt',
        label: 'netlayer-libp2p',
      }),
    );
  }
  // Row R: runtimes and CLI
  parts.push(
    node({
      x: 60,
      y: 14,
      w: 170,
      h: 64,
      name: 'browser runtime',
      body: 'PlatformServicesServer',
      note: A ? 'always libp2p' : 'registry from embedder',
      role: 'none',
    }),
  );
  parts.push(
    node({
      x: 260,
      y: 14,
      w: 190,
      h: 64,
      name: 'node runtime',
      body: 'PlatformServices · make-kernel',
      note: A ? 'imports QUIC, TCP' : 'default registry: libp2p',
      role: A ? 'hazard' : 'none',
    }),
  );
  parts.push(
    node({
      x: 700,
      y: 14,
      w: 160,
      h: 50,
      name: 'kernel-cli',
      body: 'relay command',
      role: 'none',
    }),
  );
  // Row K: kernel side
  parts.push(
    node({
      x: 60,
      y: 136,
      w: 200,
      h: 64,
      name: 'RemoteManager',
      body: 'RemoteHandle · OcapURLManager',
      note: 'Ken protocol, ocap URLs',
      role: 'goal',
    }),
  );
  parts.push(
    node({
      x: 300,
      y: 136,
      w: 180,
      h: 64,
      name: 'remote-comms',
      body: 'peerId · URL crypto',
      note: A ? '@libp2p/crypto, peer-id' : 'z… peerId · WebCrypto',
      role: A ? 'hazard' : 'goal',
    }),
  );
  parts.push(
    node({
      x: 510,
      y: 136,
      w: 140,
      h: 50,
      name: 'store',
      body: A ? 'peerId · knownRelays' : 'knownLocationHints',
      role: 'none',
    }),
  );
  // Row T: transport engine and provider
  parts.push(
    node({
      x: 60,
      y: 280,
      w: 160,
      h: 64,
      name: A ? 'transport.ts' : 'channel-netlayer',
      body: A ? 'initTransport · sessions' : 'makeChannelNetlayer',
      note: A
        ? 'imports @libp2p/interface'
        : D
          ? 'connect retry folded in'
          : 'transport-neutral',
      role: A ? 'hazard' : 'goal',
    }),
  );
  parts.push(
    node({
      x: 235,
      y: 280,
      w: 150,
      h: 64,
      name: 'session logic',
      body: 'handshake · reconnect',
      note: 'peer state · limits',
      role: 'goal',
    }),
  );
  if (!A) {
    parts.push(
      node({
        x: 400,
        y: 280,
        w: 140,
        h: 64,
        name: 'identity',
        body: 'deriveNeutralPeerId',
        note: '@noble/curves',
        role: 'goal',
        isNew: snap === 'C',
      }),
    );
  }
  parts.push(
    node({
      x: 650,
      y: 280,
      w: 200,
      h: 64,
      name: A ? 'connection-factory' : 'make-libp2p-netlayer',
      body: A ? 'builds the libp2p node' : 'ConnectionFactory · errors',
      note: A
        ? 'libp2p, noise, yamux, webrtc…'
        : D
          ? 'dial drops withRetry'
          : 'libp2p behind the seam',
      role: A ? 'hazard' : 'alt',
      isNew: snap === 'C',
    }),
  );
  // Row I: netlayers and libp2p subpaths
  if (!A) {
    parts.push(
      node({
        x: 60,
        y: 420,
        w: 160,
        h: 64,
        name: 'loopback',
        body: 'in-process hub',
        note: 'tests, embedded',
        role: 'alt',
        isNew: snap === 'C',
      }),
    );
    parts.push(
      node({
        x: 650,
        y: 420,
        w: 95,
        h: 50,
        name: './nodejs',
        body: 'QUIC · TCP',
        role: 'alt',
        isNew: snap === 'C',
      }),
    );
  }
  if (D) {
    parts.push(
      node({
        x: 235,
        y: 420,
        w: 150,
        h: 64,
        name: 'websocket',
        body: 'client · ./nodejs hub',
        note: 'deferred (phase 5)',
        role: 'alt',
        isNew: true,
      }),
    );
    parts.push(
      node({
        x: 400,
        y: 420,
        w: 140,
        h: 64,
        name: 'iroh',
        body: 'Node-only, napi',
        note: 'draft (phase 7)',
        role: 'alt',
        isNew: true,
      }),
    );
  }
  parts.push(
    node({
      x: 755,
      y: 420,
      w: 95,
      h: 50,
      name: A ? 'relay' : './relay',
      body: A ? 'kernel-utils' : 'relay server',
      role: A ? 'hazard' : 'alt',
      isNew: snap === 'C',
    }),
  );
  // Row S: support packages
  parts.push(
    node({
      x: 60,
      y: 520,
      w: 160,
      h: 64,
      name: 'kernel-shims',
      body: 'endoify-node',
      note: D ? 'follow-up: move it out' : 'imports @libp2p/webrtc',
      role: 'hazard',
    }),
  );
  parts.push(
    node({
      x: 235,
      y: 520,
      w: 150,
      h: 64,
      name: 'kernel-errors',
      body: 'network error classes',
      note: A ? 'imports @libp2p/interface' : 'neutral classes',
      role: A ? 'hazard' : 'goal',
    }),
  );

  // Edges
  if (A) {
    parts.push(
      edge([
        [60, 46],
        [30, 46],
        [30, 312],
        [58, 312],
      ]),
    );
    parts.push(
      edge([
        [280, 78],
        [280, 250],
        [140, 250],
        [140, 278],
      ]),
    );
    parts.push(label({ x: 150, y: 270, text: 'initTransport' }));
    parts.push(
      edge([
        [140, 344],
        [140, 370],
        [750, 370],
        [750, 346],
      ]),
    );
    parts.push(
      label({
        x: 445,
        y: 388,
        text: 'ConnectionFactory.make · dial',
        anchor: 'middle',
      }),
    );
  } else {
    parts.push(
      edge([
        [145, 14],
        [145, 6],
        [675, 6],
        [675, 278],
      ]),
    );
    parts.push(
      edge(
        [
          [355, 14],
          [355, 6],
        ],
        { arrow: false },
      ),
    );
    parts.push(dot([355, 6]));
    parts.push(label({ x: 681, y: 106, text: 'netlayers[specifier]' }));
    parts.push(label({ x: 681, y: 120, text: 'from the registry' }));
    parts.push(
      edge([
        [750, 344],
        [750, 370],
        [140, 370],
        [140, 346],
      ]),
    );
    parts.push(
      label({
        x: 445,
        y: 388,
        text: 'makeChannelNetlayer({ provider })',
        anchor: 'middle',
      }),
    );
    parts.push(
      edge([
        [440, 200],
        [440, 278],
      ]),
    );
  }
  parts.push(
    edge([
      [380, 136],
      [380, 80],
    ]),
  );
  parts.push(label({ x: 386, y: 112, text: 'initializeRemoteComms' }));
  parts.push(
    edge([
      [260, 168],
      [298, 168],
    ]),
  );
  parts.push(
    edge([
      [480, 168],
      [508, 168],
    ]),
  );
  parts.push(
    edge([
      [220, 312],
      [233, 312],
    ]),
  );
  parts.push(
    edge([
      [860, 39],
      [890, 39],
      [890, 445],
      [852, 445],
    ]),
  );
  parts.push(
    label({ x: 904, y: 240, text: 'startRelay', anchor: 'middle', rotate: 90 }),
  );
  return diagram({ width: 930, height: 600, ariaLabel }, parts);
}

const fig = (snap, aria, caption) =>
  `<figure>\n  <div class="diagram">${netDiagram(snap, aria)}</div>\n  <figcaption>${caption}</figcaption>\n</figure>`;

const body = `<div class="wrap">
<div class="col">
  <div class="eyebrow">ocap-kernel · remote comms, runtime to transport · four snapshots</div>
  <h1>Netlayer Stack Progress</h1>
  <p class="lede">Remote comms from the runtimes down to the transport at four points: where the netlayer stack forked from <code>main</code>, <code>main</code> today, the stack's tip, and the plan beyond it. In every snapshot the kernel reaches peers only through <code>PlatformServices</code>, with string peer ids and messages. What changes is where libp2p is imported.</p>
</div>

<nav class="strip" aria-label="Snapshots">
  <a href="#A"><div class="k">A</div><div class="t">Fork point</div><div class="s">main · 9ff2ab72 · 9 Jul</div></a>
  <a href="#B"><div class="k">B</div><div class="t">main today</div><div class="s">main · 0df99a6 · 26 Oct</div></a>
  <a href="#C"><div class="k">C</div><div class="t">Stack tip</div><div class="s">netlayer-6 · be2a958 · 10 Jul</div></a>
  <a href="#D"><div class="k">D</div><div class="t">Planned</div><div class="s">proposal</div></a>
</nav>

<div class="legend" aria-hidden="true">
  <span><i class="lg-hazard"></i>Imports libp2p outside a netlayer</span>
  <span><i class="lg-goal"></i>Transport-neutral</span>
  <span><i class="lg-alt"></i>A netlayer, transport library allowed</span>
  <span><i class="lg-none"></i>No libp2p import, outside the seam</span>
  <span><i class="lg-new"></i>New since the previous diagram</span>
</div>

<div class="col"><h2>Summary</h2></div>
<ul class="findings">
  <li><b>The stack finishes the extraction it set out to do.</b>At its tip, <code>ocap-kernel</code> has no libp2p-family dependencies (15 at the fork point) and no source file importing them (5). <code>kernel-errors</code> and <code>kernel-utils</code> drop theirs too. In package source, only <code>netlayer-libp2p</code> imports libp2p.</li>
  <li><b>None of it has landed, and <code>main</code> has moved 95 commits since the fork.</b>All six PRs have been open since 10–11 July. A trial merge of the tip into <code>main</code> conflicts in 43 files, 12 of them remote-comms code. Among the 12 are <code>channel-netlayer.ts</code> and <code>reconnection-lifecycle.ts</code>, which the stack moved and <code>main</code> kept editing at their old paths.</li>
  <li><b><code>main</code>'s changes are behavioural, not structural.</b>B has the same diagram as A: the same files import libp2p and the runtimes still call <code>initTransport</code>. But ${PR(1188)} and ${PR(1104)} change the handshake and reconnection code the stack moves into <code>@metamask/netlayer</code>, so a rebase has to port them.</li>
  <li><b>One libp2p import is still outside a netlayer.</b><code>kernel-shims</code> imports <code>@libp2p/webrtc</code> before lockdown in A, B and C. Moving it out is a review-gated follow-up, so D is the first snapshot without it.</li>
  <li><b>The plan adds netlayers, and changes the seam once more.</b>WebSocket (phase 5) is deferred, and iroh (phase 7, draft) is proposed as the second real <code>ChannelProvider</code>. Phase 7 also folds connect retry into the engine, so <code>ChannelProvider.dial</code> drops <code>withRetry</code>. That is a breaking change to the seam C introduces.</li>
</ul>

<div class="tbl"><table>
<thead><tr><th>Property</th><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead>
<tbody>
<tr><td>libp2p-family deps of <code>ocap-kernel</code></td><td class="n">15</td><td class="n">15</td><td class="n">0</td><td class="n">0</td></tr>
<tr><td><code>ocap-kernel</code> source files importing libp2p</td><td class="n">5</td><td class="n">5</td><td class="n">0</td><td class="n">0</td></tr>
<tr><td><code>kernel-errors</code> source files importing libp2p</td><td class="n">1</td><td class="n">1</td><td class="n">0</td><td class="n">0</td></tr>
<tr><td>Packages whose TypeScript source imports libp2p</td><td class="n">4</td><td class="n">4</td><td class="n">1</td><td class="n">1</td></tr>
<tr><td><code>kernel-shims</code> imports <code>@libp2p/webrtc</code></td><td class="n">yes</td><td class="n">yes</td><td class="n">yes</td><td class="n">no (follow-up)</td></tr>
<tr><td>libp2p deps of the node runtime</td><td class="n">4</td><td class="n">4</td><td class="n">1</td><td class="n">—</td></tr>
<tr><td>Netlayers to choose from</td><td class="n">none, libp2p only</td><td class="n">none, libp2p only</td><td class="n">2</td><td class="n">4</td></tr>
<tr><td>How a runtime gets its transport</td><td class="n"><code>initTransport</code></td><td class="n"><code>initTransport</code></td><td class="n">registry lookup</td><td class="n">registry lookup</td></tr>
<tr><td>peerId</td><td class="n">libp2p PeerId</td><td class="n">libp2p PeerId</td><td class="n">base58btc Ed25519 key</td><td class="n">same as C</td></tr>
<tr><td>"relay" mentions in <code>ocap-kernel</code> source</td><td class="n">314</td><td class="n">314</td><td class="n">9</td><td class="n">—</td></tr>
<tr><td>Transport engine</td><td class="n">transport.ts, 906 lines</td><td class="n">transport.ts, 943 lines</td><td class="n">channel-netlayer.ts, 820 lines</td><td class="n">+ connect retry</td></tr>
</tbody></table></div>
<p class="meta">Libp2p-family means <code>libp2p</code>, <code>@libp2p/*</code>, <code>@chainsafe/*</code> and <code>@multiformats/*</code>. Source excludes tests. In C the bare <code>multiformats</code> package (base58 only) stays in <code>ocap-kernel</code> and <code>@metamask/netlayer</code>. D's values come from the plan docs.</p>

<h2 id="A">A · Fork point</h2>
<p class="meta"><code>main</code> at <code>9ff2ab72</code> (9 Jul), the parent of every netlayer branch.</p>
${fig('A', 'Diagram A, main at 9ff2ab72. Both runtimes call initTransport in ocap-kernel, which always builds libp2p through connection-factory. remote-comms derives the peerId with libp2p crypto; transport.ts, connection-factory, the node runtime, kernel-errors, kernel-shims and the relay in kernel-utils all import libp2p. kernel-cli starts the relay.', 'Seven nodes in five packages import libp2p. Most are in <code>ocap-kernel</code>, where the transport lives. There is nothing to choose between: both runtimes call <code>initTransport</code>, which always builds a libp2p node.')}
<div class="tbl"><table>
<thead><tr><th>Node</th><th>What it does</th><th>libp2p import</th></tr></thead>
<tbody>
<tr><td class="st">remote-comms</td><td>Derives the peerId from <code>keySeed</code>, encrypts ocap-URL oids, keeps the relay pool, calls <code>initializeRemoteComms</code>.</td><td><code>@libp2p/crypto</code>, <code>@libp2p/peer-id</code></td></tr>
<tr><td class="st">transport.ts</td><td><code>initTransport</code>: channels, handshakes, reconnection, sends. Exported from <code>ocap-kernel</code>.</td><td><code>@libp2p/interface</code>, <code>@libp2p/utils</code></td></tr>
<tr><td class="st">connection-factory</td><td>Builds the libp2p node with a fixed transport set (WebRTC, WebSockets, WebTransport, circuit relay) and dials.</td><td>libp2p and its transports</td></tr>
<tr><td class="st">node runtime</td><td>Turns listen addresses into QUIC and TCP transports and passes them in as <code>directTransports</code>.</td><td><code>@chainsafe/libp2p-quic</code>, <code>@libp2p/tcp</code></td></tr>
<tr><td class="st">relay</td><td>The relay server in <code>kernel-utils/libp2p</code>, started by <code>kernel-cli</code>.</td><td>libp2p and its transports</td></tr>
<tr><td class="st">kernel-errors</td><td>Decides which network errors are retryable.</td><td><code>MuxerClosedError</code></td></tr>
<tr><td class="st">other nodes</td><td><code>RemoteManager</code>, session logic and the store import no libp2p. The store holds libp2p data as strings (peerId, relay multiaddrs). <code>remotes/types.ts</code> and <code>utils/multiaddr.ts</code> also import libp2p and are folded into the nodes above.</td><td>—</td></tr>
</tbody></table></div>

<h2 id="B">B · main today</h2>
<p class="meta"><code>main</code> at <code>0df99a6</code> (26 Oct): A plus 95 commits, 33 of which touch remote comms or the runtimes.</p>
<p>B has the same diagram as A. The libp2p imports, the dependency counts, <code>initTransport</code>'s signature and the ocap-URL format are all unchanged. The behaviour inside the boxes did change. A rebase of the stack has to carry these:</p>
<div class="tbl"><table>
<thead><tr><th>PR</th><th>What changed</th><th>Where the stack has it</th></tr></thead>
<tbody>
<tr><td class="st">${PR(1188)}</td><td>One outbound handshake per channel, shared by concurrent dials. Reconnection closes and re-dials when a peer reports a restart. A send's dial retry uses the reconnection delays.</td><td><code>netlayer/channel-netlayer.ts</code>, <code>reconnection-lifecycle.ts</code>, <code>netlayer-libp2p/connection-factory.ts</code></td></tr>
<tr><td class="st">${PR(1104)}</td><td>A peer's incarnation change becomes a run-loop item; the outbound handshake result carries the remote incarnation id.</td><td><code>channel-netlayer.ts</code>, <code>reconnection-lifecycle.ts</code>, <code>remotes/types.ts</code></td></tr>
<tr><td class="st">${PR(1101)}, ${PR(1103)}, ${PR(1204)}</td><td>Remote sends wait for the crank to commit; each inbound message gets its own crank; <code>withRemote</code> replaces <code>remoteFor</code>.</td><td><code>RemoteHandle</code>, <code>RemoteManager</code>, <code>OcapURLManager</code> (still in <code>ocap-kernel</code>)</td></tr>
<tr><td class="st">repo-wide</td><td>ESM-only <code>tsc</code> build (${PR(1186)}), TypeScript 7 (${PR(1194)}), oxc instead of eslint and prettier (${PR(1192)}), type-checked tests (${PR(1195)}), no <code>baseUrl</code> (${PR(1190)}).</td><td>All three new packages' config, and every lint directive</td></tr>
</tbody></table></div>
<p class="meta">The trial merge (<code>git merge-tree</code>, tip into <code>main</code>) conflicts in 43 files. Twelve are remote-comms code: the node runtime's <code>PlatformServices.ts</code> and <code>make-kernel.ts</code>, <code>remote-comms.ts</code>, <code>OcapURLManager.ts</code>, <code>remotes/types.ts</code>, <code>channel-netlayer.ts</code>, <code>reconnection-lifecycle.ts</code>, and five test files. Of the other 31, 21 are changelogs, package manifests, tsconfigs and <code>yarn.lock</code>. The rest include the store's relay methods, which ${PR(974)} renames, the package index and tests.</p>

<h2 id="C">C · Stack tip</h2>
<p class="meta"><code>rekm/netlayer-6</code> at <code>be2a958</code> (10 Jul): A plus ${PR(969)}–${PR(974)}, all open. There is no phase 5 PR: it was deferred.</p>
${fig('C', 'Diagram C, the stack tip. ocap-kernel keeps RemoteManager, remote-comms and the store, none of which import libp2p. The new @metamask/netlayer package holds the channel-netlayer engine, session logic and the neutral identity. Runtimes look up a netlayer factory in a registry; the libp2p factory in netlayer-libp2p builds its ConnectionFactory and hands it to makeChannelNetlayer. netlayer-libp2p also has ./nodejs (QUIC, TCP) and ./relay subpaths. A loopback netlayer is the second implementation. kernel-shims still imports @libp2p/webrtc.', 'The transport has left <code>ocap-kernel</code>. The engine and session logic are neutral and live in <code>@metamask/netlayer</code>. Everything libp2p is in <code>netlayer-libp2p</code>, which a runtime reaches through its registry instead of a hard-wired call.')}
<div class="tbl"><table>
<thead><tr><th>Layer</th><th>What it moves in the diagram</th><th>Files</th></tr></thead>
<tbody>
<tr><td class="st">${PR(969)} plans</td><td>Plan docs only (and <code>.gitignore</code>).</td><td class="n">8</td></tr>
<tr><td class="st">${PR(970)} phase 1</td><td>Adds the <code>NetworkChannel</code>/<code>ChannelProvider</code> seam inside <code>ocap-kernel</code>; <code>transport.ts</code> and <code>remotes/types.ts</code> stop importing libp2p, leaving it to <code>connection-factory</code>, <code>remote-comms</code> and <code>utils/multiaddr</code>. <code>transport.ts</code> splits into the engine plus an <code>initTransport</code> wrapper. <code>kernel-errors</code> gains neutral error classes.</td><td class="n">27</td></tr>
<tr><td class="st">${PR(971)} phase 2</td><td>Adds <code>identity</code>: the peerId becomes the base58btc Ed25519 key, and URL crypto moves to WebCrypto. <code>kernel-errors</code> drops libp2p.</td><td class="n">20</td></tr>
<tr><td class="st">${PR(972)} phase 3</td><td>Adds <code>@metamask/netlayer</code> (engine, session logic, identity, types) and <code>netlayer-loopback</code>.</td><td class="n">68</td></tr>
<tr><td class="st">${PR(973)} phase 4</td><td>Adds <code>netlayer-libp2p</code> with <code>./nodejs</code> and <code>./relay</code>; <code>remotes/platform</code> is deleted. Runtimes take a <code>NetlayerRegistry</code>, and <code>ocap-kernel</code> drops all 15 libp2p deps.</td><td class="n">122</td></tr>
<tr><td class="st">${PR(974)} phase 6</td><td>Renames relay to location hint on the kernel surface and in the store; adds the netlayer guide and the phase 7 draft. No box moves.</td><td class="n">38</td></tr>
</tbody></table></div>
<h3>A → C</h3>
<ul class="changes">
  <li><code>transport.ts</code> → <code>channel-netlayer</code> in <code>@metamask/netlayer</code>, with no libp2p imports (${PR(970)}, ${PR(972)}).</li>
  <li><code>connection-factory</code> → <code>netlayer-libp2p</code>, now the only package source that imports libp2p (${PR(973)}).</li>
  <li>The runtimes stop calling <code>initTransport</code>. They look up <code>specifier.netlayer</code> in a registry; the browser's registry is supplied by its embedder (extension, omnium) (${PR(973)}).</li>
  <li>QUIC and TCP leave the node runtime for <code>netlayer-libp2p/nodejs</code>; the relay leaves <code>kernel-utils</code> for <code>netlayer-libp2p/relay</code> (${PR(973)}).</li>
  <li>The peerId and the ocap-URL host become the neutral <code>z…</code> id; persisted ids and URLs are incompatible by design (${PR(971)}).</li>
  <li><code>knownRelays</code> → <code>knownLocationHints</code> in the store and kernel options. The netlayer config key stays <code>knownRelays</code> (${PR(974)}).</li>
</ul>

<h2 id="D">D · Planned</h2>
<p class="meta">Proposal: <code>docs/plans/netlayer/phase-5.md</code> (deferred), <code>phase-7-iroh.md</code> (draft, not scheduled) and the follow-ups that <code>phase-6.md</code> §1a carries forward.</p>
${fig('D', 'Diagram D, the planned target. Same as C, plus a websocket netlayer with a ./nodejs hub (deferred) and an iroh netlayer for Node only (draft). The engine absorbs connect retry, so the provider dial drops withRetry. kernel-shims still imports @libp2p/webrtc, with a follow-up to move it out.', 'The plan adds netlayers without moving any box C already has. The one change to existing code is the retry seam: phase 7 moves connect retry into the engine. <code>kernel-shims</code> keeps its libp2p import until its follow-up lands.')}
<h3>C → D</h3>
<ul class="changes">
  <li>Adds <code>netlayer-websocket</code>: a browser-safe client, plus a <code>./nodejs</code> hub that authenticates with an Ed25519 challenge signature. Hub and spoke only; the hub does not forward between clients (phase 5).</li>
  <li>Adds <code>netlayer-iroh</code> for Node through napi. Browsers keep libp2p (phase 7, non-goals).</li>
  <li><code>ChannelProvider.dial</code> drops <code>withRetry</code> once connect retry moves into the engine. Phase 7 also adds a provider conformance suite in <code>@ocap/test-utils</code>.</li>
  <li>Follow-ups from C: move the <code>@libp2p/webrtc</code> import out of <code>kernel-shims</code>, and retire the <code>libp2pComms</code> test helper.</li>
</ul>
<div class="note"><b>Open in the plans.</b> Which netlayer comes next: iroh is "proposed to supersede the deferred WebSocket phase", while phase 5 "remains an independent, still-valid future option". Whether the retry seam is in scope: "If descoped, iroh must implement its own connect backoff". Whether iroh's native module survives SES lockdown, which the phase 7 spike gates. And until the node runtime's default registry stops importing the libp2p factory, a WebSocket-only Node deployment "still pulls <code>@libp2p/webrtc</code> transitively". master.md also leaves an iroh browser build open "if/when the trade-offs justify it", which phase 7's non-goals rule out.</div>

<footer>A and B are read from <code>ocap-kernel/src/remotes/**</code>, <code>kernel-errors</code>, <code>kernel-shims/src/endoify-node.js</code>, <code>kernel-utils/src/libp2p-relay.ts</code> and both runtimes' <code>PlatformServices</code> at <code>9ff2ab72</code> and <code>0df99a6</code>. C is read from <code>packages/netlayer*</code> and the same paths at <code>be2a958</code>. D is a proposal, from <code>docs/plans/netlayer/*.md</code> at <code>be2a958</code>. The table comes from the stack-progress probes; the conflict count is a <code>git merge-tree</code> trial merge.</footer>
</div>
`;
writeFileSync(
  new URL('./netlayer-progress.html', import.meta.url),
  head + body,
);
console.log('built');
