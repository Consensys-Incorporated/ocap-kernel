import type { JsonRpcMiddleware } from '@metamask/json-rpc-engine/v2';
import { Logger } from '@metamask/logger';

export const makeLoggingMiddleware =
  (logger: Logger): JsonRpcMiddleware =>
  async ({ next }) => {
    const start = performance.now();
    try {
      // oxlint-disable-next-line node/callback-return
      await next();
    } finally {
      const duration = performance.now() - start;
      logger.debug(`Command executed in ${duration}ms`);
    }
  };
