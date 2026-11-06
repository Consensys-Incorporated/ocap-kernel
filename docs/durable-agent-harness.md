# Durable agent harness

Draft, 2026-11-06. A feature map for the next month, written against the
kernel as of #1217 and the agent-vat stack (#1253–#1259).

## Goals

An agent's work survives the process that runs it. If the kernel crashes, the
agent resumes. If inference fails mid-stream, the kernel re-prompts from the
last committed turn, with a compacted transcript when the failure was running
out of context. Moving an agent between devices is a stretch goal that the
kernel's remote comms make plausible, not a requirement.

The frontend is abstract: a CLI, a mobile app, a remote kernel. Several views
with different control facets watch one agent at once. Each receives the
inference stream from the kernel, possibly rewritten by vats along the way, at
streaming granularity rather than by polling, so people can watch the agent
think, guide it, or abort it.

Inference goes through `@metamask/kernel-language-model-service`, built for a
local provider over HTTPS so that paid providers follow. The frontend never
talks to the engine directly.

Concurrent agents, in particular asynchronous subagents, are expected.
Throughput under load (#1217) is a known limit and is addressed when it is
reached.

## Decisions taken

These came out of the scoping discussion and fix the design below.

- **Partial text is retained, not resumed by the engine.** A generation that
  fails or is aborted leaves a partial message at the tip of the transcript.
  The next turn regenerates; the partial message stays visible and may be
  rendered into the prompt. Engine-level continuation of an assistant message
  is a per-provider feature, not part of the harness.
- **Batching is a given; granularity is the consumer's.** A vat that must
  rule out a disrespectful sentence cannot judge tokens. Each consumer holds
  back as much as it needs and releases what it has cleared.
- **Rewriting is a vat.** It takes a stream, holds the longest suffix that
  could still become a forbidden term, and releases the rest as its own
  stream. Injection into a stream is deferred until the stream exists.
- **Two kinds of fork.** Two consumers of one stream, and a subagent that
  starts from the parent's transcript. They share one primitive (below).
- **Backpressure is a buffer budget.** The exact policy is open.
- **Plugin vats act on partial progress.** A monitor that searches documents
  while the model thinks is one example; its authority is attenuated the way
  any capability is.
- **Abort travels with the stream as a separate capability.** A vat may pass
  the stream on without it, or wrap it. `abort()` resolves with the outcome or
  rejects with why it could not.
- **Compaction is visible, not seamless.** What to show a user is a UI
  question. What was compacted is retained as storage permits.
- **Subagent spawning is a tool call in the ocap style.** The parent endows
  the child with any capability it can reference, including ones it made. The
  parent's budget covers children; terminating the parent terminates them.
  The call returns a control facet; the child answers with a message in the
  parent's transcript and may keep running to take further instructions.
  Nothing streams back to the parent at the token level.
- **Codemode runs in its own vat**, endowed only with granted capabilities,
  which may be kernel platform exos or narrowings of them. Durable codemode
  state across restarts is research and out of scope.
- **Compute and memory are metered by vat count** for now: the kernel hands
  out metered capabilities to create vats, and spawning consumes one.

## The primitive

Every feature above is a view of one object: a durable, append-only **chunk
log** kept in vat baggage, read through **cursors**, with **abort** as a
separate capability.

```ts
type Cursor = string;

type ChunkLog<Chunk> = {
  /** Resolves once at least one chunk follows `cursor`, or the log ends. */
  read(
    cursor: Cursor,
  ): Promise<{ chunks: Chunk[]; cursor: Cursor; done: boolean }>;
};

type Writer<Chunk> = {
  append(chunk: Chunk): Promise<void>;
  end(): Promise<void>;
  fail(reason: Error): Promise<void>;
};

type Abort = {
  /** Resolves when generation has stopped; rejects with why it could not. */
  abort(reason?: string): Promise<{ stopped: true }>;
};
```

- A pending `read` is the push: the frontend's read resolves when the next
  batch lands. No polling, no per-token round trips.
- A reader is a cursor, so two consumers of one stream are two cursors, and a
  consumer that keeps its cursor in its own baggage resumes after a restart.
- The buffer budget is the distance the head may run ahead of the slowest
  cursor before the writer blocks or the cursor is dropped.
- A **transcript** is a log whose chunks are messages, and a message may
  reference a chunk log of its own. That is the hierarchical stream. A forked
  subagent's transcript shares the parent's prefix by reference and appends
  its own messages. Compaction writes a new transcript **version** whose entry
  replaces a range and points at the originals.
- Abort is a capability object. Forwarding the reader without it withholds
  it. "Abort when every consumer has aborted" is a wrapper written in user
  space.

The log is a library over baggage, not a kernel primitive. It needs nothing
the kernel does not already give a vat, which keeps kernel changes to the two
API additions below.

## Inference edge

The language model service hosts a per-request reader (#1230) with `read()`
returning every chunk since the last read, `close()` aborting the upstream
request, and the last batch held until the next read acknowledges it, so a
batch delivered in a crank that aborts is not lost. An **ingest vat** copies
that reader into a chunk log and owns the abort capability for it.

A kernel restart destroys hosted readers. The ingest vat's next read is
rejected as unreachable; the agent treats that as an inference failure and
re-prompts from the last committed turn with the partial message retained.

## Workstreams

Sizes are engineer-days, assuming the agent-vat stack and #1229 land in the
first week.

| #   | Workstream                                                                                                                                                       | Depends on             | Size |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---- |
| A   | Kernel: a registered service may host per-session objects (#1230 step 2)                                                                                         | design agreement       | 2    |
| B   | Inference edge: `chatStream` and `sampleStream` readers, abort plumbed to `fetch`, acknowledged batches, SSE mock, partial text on abort                         | A                      | 4    |
| C   | Chunk log library: cursor reads, buffer budget, fork, abort capability, baggage persistence; unit and in-kernel tests                                            | none                   | 5    |
| D   | Pipeline vats: ingest, rewriting with held-back suffix, a monitor acting on partial text                                                                         | B, C                   | 4    |
| E   | Frontend delivery: a host sink service for in-process frontends, a reader exposed by ocap URL for remote ones, attenuated control facets (monitor, guide, abort) | C                      | 4    |
| F   | Transcript: message log with shared prefixes, versions, compaction with retained originals, rendering to a prompt                                                | C                      | 5    |
| G   | Durable agent: task state machine in baggage, resume after restart, re-prompt on failure, compaction on out-of-context                                           | B, F, agent-vat stack  | 6    |
| H   | Kernel: a metered vat-launch capability for non-system vats, child lifetime tied to parent                                                                       | design agreement       | 3    |
| I   | Subagents: `spawn` tool call taking capabilities and budget, forked transcript, control facet, results as transcript messages, shared budget                     | F, G, H                | 6    |
| J   | Codemode vat: the REPL evaluator in its own vat with granted capabilities only; terminate to stop runaway code                                                   | agent-vat stack, #1256 | 4    |

About 43 engineer-days. Two people in parallel: one on A, B, D, E, J; the
other on C, F, G, H, I. C and F go first since most of the rest hangs off
them.

### Sequencing

1. Land the open stack and #1229. Start A and C. One design review covers
   both kernel API changes, A and H.
2. B and F. A vat can stream from the engine into a durable log; a transcript
   can be compacted and re-rendered.
3. D, E, G. Demo: the #1230 redaction demo, made durable. Kill the kernel
   mid-generation, restart, watch the agent resume with the partial tip
   retained.
4. H, I, J. Demo: an agent spawns a subagent with a narrowed capability and a
   forked transcript; the child reports back as a transcript message; the
   parent's abort terminates it.

### Deferred

Content injection into a stream. Device switch (E lays the groundwork).
Durable codemode state. Compute metering beyond vat count.

## Risks

- **Crank rollback of service answers** (#1168, #1177). Every inference batch
  crosses this path. B's acknowledgement hold covers lost batches; a kernel
  fix removes a class of flakiness from the whole month.
- **Throughput** arrives in week 3 if the ingest vat reads per token. Batching
  in the reader keeps it away. The log library should refuse one chunk per
  message.
- **Pins from #1229.** A frontend reading through `queueMessage` pins every
  result forever. E prefers the host sink and the remote reader, which avoid
  that path.
- **Agent layer versus vats.** This design puts each agent in a vat, because
  durability, termination and capability isolation already live there. A
  cross-cutting layer can coordinate across vats. If the layer is to own
  state instead, G changes shape; decide before week 3.

## Open questions

- Does `spawn` create a child subcluster, or a vat in the parent's? Child
  lifetime tied to parent is simplest with a subcluster per agent tree.
- Are multiuser control facets issued by the agent vat or by a separate
  supervisor vat?
- The buffer budget policy: block the writer, or drop the slowest cursor?

## Scenarios

Each of these is awkward in a harness that keeps the stream in process memory
and ties abort to the process, and plain here.

**Crash mid-generation.** The ingest vat appends batches to the log and keeps
its cursor in baggage. After a restart, the agent vat finds the log ended with
`failed`, the tip message marked partial. It renders the transcript with the
partial message and re-prompts. Nothing re-reads the engine.

**Two viewers, one abort.** The agent hands the frontend a reader and a
narrowed abort; it hands a redaction vat only the reader. The redaction vat
cannot stop generation; the viewer can. Both see the same log.

```ts
const viewerFacet = harden({ read: log.read, abort: abort.abort });
const redactorFacet = harden({ read: log.read });
```

**Abort when all agree.**

```ts
const makeQuorumAbort = (inner: Abort, parties: number): Abort[] => {
  let remaining = parties;
  return Array.from({ length: parties }, () =>
    makeDefaultExo('QuorumAbort', {
      async abort(reason?: string) {
        remaining -= 1;
        return remaining === 0 ? inner.abort(reason) : { stopped: false };
      },
    }),
  );
};
```

**Compaction while the tip generates.** A compactor vat reads messages 20 to
30 from the transcript, writes a summary message `C`, and publishes version
`n + 1` with `C` in their place. The agent's current generation keeps
appending to message 36. On the next prompt the agent renders version
`n + 1`: `M1 … M19, C, M31 … M36`. The originals remain behind `C`.

**A plugin that reads the think stream.** A search vat holds a cursor on the
same log and a read-only document capability. When the partial text names a
subject, it appends a note to the transcript. The agent did not change.

**Subagent with less authority.**

```ts
const child = await E(tools).spawn({
  intent: 'summarize the wallet history',
  capabilities: { http: narrow(http, { hosts: ['api.example.com'] }) },
  budget: budget.split(0.3),
});
await E(child).instruct('only the last 30 days');
await E(child).abort('no longer needed');
```

**Runaway model code.** A `Compartment` cannot be interrupted. A codemode vat
can be terminated, and with it everything the code held.
