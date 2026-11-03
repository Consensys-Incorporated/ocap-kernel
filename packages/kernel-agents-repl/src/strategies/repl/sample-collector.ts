import { SampleGenerationError } from '@metamask/kernel-errors';
import type { Logger } from '@metamask/logger';
import type { SampleCollector } from '@ocap/kernel-agents/types';

/**
 * A simple sample collector that collects content from a stream until a stop
 * string is encountered and returns the content prior, trimmed.
 *
 * XXX This functionality is typically available in the language model service,
 * but a reimplementation appears here to remain agnostic to the service API.
 *
 * @param args - The arguments to make the sample collector.
 * @param args.stop - The stop string to stop collection.
 * @param args.maxChunkCount - The maximum number of chunks to collect before
 *   throwing an error.
 * @param args.logger - The logger to use for the sample collector.
 * @returns A function that collects a delta of a streaming response, returning
 *   the statement code if the stop string is encountered or null otherwise.
 */
export const makeSampleCollector = ({
  stop,
  maxChunkCount = 200,
  logger,
}: {
  stop: string;
  maxChunkCount?: number;
  logger?: Logger;
}): SampleCollector<string> => {
  let buffer = '';
  let chunkCount = 0;
  return (delta: string) => {
    chunkCount += 1;
    buffer += delta;
    if (buffer.includes(stop)) {
      const [content] = buffer.split(stop);
      if (content === undefined || content.trim() === '') {
        throw new SampleGenerationError(buffer, new Error('Empty content'));
      }
      logger?.info('content:', content);
      return content.trim();
    }
    if (maxChunkCount && chunkCount > maxChunkCount) {
      throw new SampleGenerationError(
        buffer,
        new Error('Max chunk count reached'),
      );
    }
    return null;
  };
};
