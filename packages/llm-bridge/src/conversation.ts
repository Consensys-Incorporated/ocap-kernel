/**
 * Conversation manager that the bridge interposes between the matcher
 * vat and the LLM gateway.
 *
 * The bridge owns the conversation history. Service registrations are
 * appended to a *persistent* history (each as a user/assistant pair).
 * Queries are non-accumulating: each query temporarily appends one
 * user turn to a snapshot of the persistent history, gets a reply,
 * parses the reply as JSON, and discards both before the next query.
 * That way query traffic doesn't pollute the matcher's view of the
 * registry, and persistent-history growth is bounded by the
 * registration rate rather than the consumer-query rate.
 */

import type { ChatMessage, OpenClawClient } from './openclaw-client.ts';
import type { IngestRequest, MatchEntry } from './protocol.ts';

const SYSTEM_PROMPT = `You are a service-discovery matcher. You maintain a registry of services and rank candidates against natural-language queries.

You will receive "Register service" messages, each describing a single service: an opaque ID, a one-sentence description, and a list of method names with optional descriptions. Acknowledge each registration with a short confirmation; you do not need to elaborate.

You will then receive "Query" messages asking which registered services match a given user intent. For each query, reply with a JSON array AND NOTHING ELSE — no prose, no commentary, no markdown code fences. Each array element must be an object of the form {"id":"<service id>","rationale":"<one-sentence reason>"}. Order best-first. If no service matches, reply []. Never invent IDs you were not told about.`;

export type Conversation = {
  /**
   * Append a service registration to the persistent history.
   *
   * @param request - The ingest request from the matcher vat.
   */
  ingest(request: IngestRequest): Promise<void>;

  /**
   * Send a free-text query and parse the LLM's JSON reply into
   * structured matches. Does not mutate persistent history.
   *
   * @param query - The query text from the consumer.
   * @returns Parsed match entries, ranked best-first.
   */
  query(query: string): Promise<MatchEntry[]>;
};

/**
 * Build a {@link Conversation} backed by an {@link OpenClawClient}.
 *
 * @param client - HTTP client to use for chat completions.
 * @returns A new conversation manager.
 */
export function makeConversation(client: OpenClawClient): Conversation {
  const persistent: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  return {
    async ingest(request: IngestRequest): Promise<void> {
      // Build the user turn locally; only commit both turns once the
      // reply has resolved. If `client.chat` rejects (gateway 5xx,
      // token error, transient network), the persistent log would
      // otherwise be left with an unpaired user turn, and every
      // subsequent ingest would send a malformed multi-user-turn
      // sequence — degrading ranker behavior and matching the matcher
      // vat's own rollback semantics on bridge-ingest failure.
      const userTurn: ChatMessage = {
        role: 'user',
        content: formatIngest(request),
      };
      const reply = await client.chat([...persistent, userTurn]);
      persistent.push(userTurn, { role: 'assistant', content: reply });
    },

    async query(query: string): Promise<MatchEntry[]> {
      // Snapshot the persistent history with one ephemeral query turn.
      // Both the user message and the LLM's reply are discarded once
      // the query is answered — see the file-level comment for why.
      const messages: ChatMessage[] = [
        ...persistent,
        { role: 'user', content: formatQuery(query) },
      ];
      const reply = await client.chat(messages);
      return parseMatches(reply);
    },
  };
}

/**
 * Format a single ingest request as a multi-line user message.
 *
 * @param request - The ingest request.
 * @returns The user-message content.
 */
function formatIngest(request: IngestRequest): string {
  const { service } = request;
  const methodLines =
    service.methods.length === 0
      ? '  (no methods documented)'
      : service.methods
          .map(
            (method) =>
              `  - ${method.name}${method.description ? `: ${method.description}` : ''}`,
          )
          .join('\n');
  return [
    `Register service ${service.id}:`,
    `  Description: ${service.description}`,
    `  Methods:`,
    methodLines,
  ].join('\n');
}

/**
 * Format the per-query user turn. Repeats the JSON-only output rule
 * inline so it can't be lost in a long context window.
 *
 * @param query - The free-text query.
 * @returns The user-message content.
 */
function formatQuery(query: string): string {
  return [
    `Query: ${query}`,
    '',
    'Reply with a JSON array of {"id","rationale"} objects, ranked best-first, or [] if nothing matches. Reply with JSON ONLY — no prose, no markdown code fences.',
  ].join('\n');
}

/**
 * Parse the LLM's textual reply as a match list. Tolerates an outer
 * markdown code fence (some models add one despite instructions) but
 * otherwise insists on the exact `[{id, rationale}, ...]` shape.
 *
 * @param reply - The raw text returned by the LLM.
 * @returns The parsed match list.
 * @throws If the reply isn't JSON, isn't an array, or any entry is
 * missing the `id`/`rationale` strings.
 */
function parseMatches(reply: string): MatchEntry[] {
  const trimmed = reply
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`LLM reply was not parseable JSON: ${reply}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`LLM reply was not a JSON array: ${reply}`);
  }
  const result: MatchEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`LLM reply array contained a non-object: ${reply}`);
    }
    const { id } = entry as Record<string, unknown>;
    const { rationale } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof rationale !== 'string') {
      throw new Error(
        `LLM reply array entry missing string id/rationale: ${reply}`,
      );
    }
    result.push({ id, rationale });
  }
  return result;
}
