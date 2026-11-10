/**
 * LLM ranking for the matcher vat: prompt construction and reply
 * parsing. Pure functions — the vat supplies the registry digests and
 * performs the actual `languageModelService` call.
 *
 * Ranking is stateless: every query presents the full current registry
 * to the model in a single completion request. There is no conversation
 * to keep in sync with the registry, so registrations never involve the
 * LLM and the model can never cite a stale entry that the registry has
 * already evicted.
 */

/** Per-method digest included in the ranking prompt. */
export type MethodDigest = {
  name: string;
  description?: string;
};

/** Compact projection of a registered service for the ranking prompt. */
export type ServiceDigest = {
  id: string;
  description: string;
  methods: MethodDigest[];
};

/** A single ranked match cited by the model. */
export type MatchEntry = {
  id: string;
  rationale: string;
};

export const MATCHER_SYSTEM_PROMPT = `You are a service-discovery matcher. You rank registered services against natural-language queries.

You will receive a registry of services — each with an opaque ID, a one-sentence description, and a list of method names with optional descriptions — followed by a query describing a user intent.

Reply with a JSON array AND NOTHING ELSE — no prose, no commentary, no markdown code fences. Each array element must be an object of the form {"id":"<service id>","rationale":"<one-sentence reason>"}. Order best-first. If no service matches, reply []. Never invent IDs that are not in the registry.`;

/**
 * Format a single service digest as a block in the ranking prompt.
 *
 * @param digest - The service digest.
 * @returns The formatted registry block.
 */
function formatDigest(digest: ServiceDigest): string {
  const methodLines =
    digest.methods.length === 0
      ? '  (no methods documented)'
      : digest.methods
          .map(
            (method) =>
              `  - ${method.name}${method.description ? `: ${method.description}` : ''}`,
          )
          .join('\n');
  return [
    `Service ${digest.id}:`,
    `  Description: ${digest.description}`,
    `  Methods:`,
    methodLines,
  ].join('\n');
}

/**
 * Format the user turn of a ranking request: the full registry followed
 * by the query. Repeats the JSON-only output rule inline so it can't be
 * lost in a long context window.
 *
 * @param digests - Digests of every currently registered service.
 * @param query - The free-text query.
 * @returns The user-message content.
 */
export function formatRankingPrompt(
  digests: ServiceDigest[],
  query: string,
): string {
  return [
    'Registry:',
    '',
    ...digests.map(formatDigest),
    '',
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
export function parseMatches(reply: string): MatchEntry[] {
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
