/**
 * Wire protocol for the LLM bridge.
 *
 * The bridge talks to its caller (the matcher vat, in this codebase)
 * over a Unix socket as line-delimited JSON. Two request kinds, three
 * possible reply kinds. The bridge owns conversation state; the caller
 * just sends digests of services as they register and free-text queries
 * as consumers ask for matches.
 */

import {
  array,
  exactOptional,
  literal,
  object,
  string,
  union,
} from '@metamask/superstruct';
import type { Infer } from '@metamask/superstruct';

/**
 * Per-method digest sent over the wire. The full `MethodSpec` type from
 * `@metamask/service-discovery-types` carries a recursive parameter/return
 * type tree we don't need the LLM to see.
 */
export const MethodDigestStruct = object({
  name: string(),
  description: exactOptional(string()),
});
export type MethodDigest = Infer<typeof MethodDigestStruct>;

/**
 * Compact projection of a `ServiceDescription` that the bridge actually
 * uses in its prompts. The caller supplies the opaque `id` (which the
 * LLM will cite back in its query replies).
 */
export const ServiceDigestStruct = object({
  id: string(),
  description: string(),
  methods: array(MethodDigestStruct),
});
export type ServiceDigest = Infer<typeof ServiceDigestStruct>;

export const IngestRequestStruct = object({
  kind: literal('ingest'),
  service: ServiceDigestStruct,
});
export type IngestRequest = Infer<typeof IngestRequestStruct>;

export const QueryRequestStruct = object({
  kind: literal('query'),
  query: string(),
});
export type QueryRequest = Infer<typeof QueryRequestStruct>;

export const RequestStruct = union([IngestRequestStruct, QueryRequestStruct]);
export type Request = Infer<typeof RequestStruct>;

export const IngestedReplyStruct = object({
  kind: literal('ingested'),
});
export type IngestedReply = Infer<typeof IngestedReplyStruct>;

export const MatchEntryStruct = object({
  id: string(),
  rationale: string(),
});
export type MatchEntry = Infer<typeof MatchEntryStruct>;

export const MatchesReplyStruct = object({
  kind: literal('matches'),
  matches: array(MatchEntryStruct),
});
export type MatchesReply = Infer<typeof MatchesReplyStruct>;

export const ErrorReplyStruct = object({
  kind: literal('error'),
  message: string(),
});
export type ErrorReply = Infer<typeof ErrorReplyStruct>;

export const ReplyStruct = union([
  IngestedReplyStruct,
  MatchesReplyStruct,
  ErrorReplyStruct,
]);
export type Reply = Infer<typeof ReplyStruct>;
