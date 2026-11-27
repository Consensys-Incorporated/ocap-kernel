import { SampleGenerationError } from '@metamask/kernel-errors';
import type { Logger } from '@metamask/logger';

import { ifDefined, withAbort, gatherStreamingResponse } from '../../utils.ts';
import { StatementMessage } from './messages.ts';
import { makeSampleCollector } from './sample-collector.ts';

export const makeReader =
  ({ logger }: { logger?: Logger }) =>
  async ({
    stream,
    abort,
    stop,
  }: {
    stream: AsyncIterable<{ response: string }>;
    abort: () => Promise<void>;
    stop: string;
  }): Promise<StatementMessage> => {
    const sampleLogger = logger?.subLogger({ tags: ['sample'] });
    const gatherLogger = logger?.subLogger({ tags: ['gather'] });
    const code = await withAbort(
      abort,
      async (): Promise<string> =>
        await gatherStreamingResponse({
          stream,
          parse: makeSampleCollector({
            stop,
            ...ifDefined({ logger: sampleLogger }),
          }),
          ...ifDefined({ logger: gatherLogger }),
        }),
    );
    try {
      return StatementMessage.fromCode(code);
    } catch (error) {
      // A sample that does not parse is resampled, as an empty one is.
      throw new SampleGenerationError(
        code,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };
