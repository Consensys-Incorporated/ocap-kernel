import type { LogEntry } from '@metamask/logger';

/**
 * Convert a list of log entries into a list of lines suitable for examination.
 *
 * @param entries - The list of log entries to convert.
 * @param withTags - The tags to filter by.
 *
 * @returns the relevant contents of `entries`, massaged for use.
 */
export function extractTestLogs(
  entries: LogEntry[],
  ...withTags: string[]
): string[] {
  const hasTag =
    withTags.length > 0
      ? (tags: string[]) => withTags.some((tag) => tags.includes(tag))
      : () => true;
  return entries
    .filter(({ tags }) => tags.includes('test') && hasTag(tags))
    .map(({ message }) => message ?? '')
    .filter((message) => message.length > 0);
}
