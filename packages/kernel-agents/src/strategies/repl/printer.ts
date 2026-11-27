import type { Logger } from '@metamask/logger';

import { ResultMessage } from './messages.ts';
import type { ReplTranscript, StatementMessage } from './messages.ts';

export const makePrinter = ({
  history,
  logger,
}: {
  history: ReplTranscript;
  logger?: Logger;
}) => {
  // Render initial state
  for (const message of history) {
    if (message instanceof ResultMessage) {
      const lines = message
        .toReplString()
        .split('\n')
        .filter(
          (line) => line.trim() === line || line.startsWith('  "description"'),
        );
      if (lines && lines?.length > 0) {
        logger?.info(lines?.join('\n'));
      }
      continue;
    }
    logger?.info(message.toReplString());
  }
  return (statement: StatementMessage, result: ResultMessage | null) => {
    logger?.info(statement.toReplString());
    if (result) {
      logger?.info(result.toReplString());
    }
  };
};
