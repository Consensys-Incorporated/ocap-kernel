import type { Logger } from '@metamask/logger';
import {
  ifDefined,
  withAbort,
  gatherStreamingResponse,
} from '@ocap/kernel-agents/utils';

import { StatementMessage } from './messages.ts';
import type { Parser } from './parse/syntax-tree.ts';
import { makeSampleCollector } from './sample-collector.ts';

export const makeReader =
  ({ parser, logger }: { parser: Parser; logger?: Logger }) =>
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
    return await StatementMessage.fromCode(code, parser);
  };
