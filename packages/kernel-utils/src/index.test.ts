import { describe, it, expect } from 'vitest';

import * as indexModule from './index.ts';

describe('index', () => {
  it('has the expected exports', () => {
    expect(Object.keys(indexModule).sort()).toStrictEqual([
      'CapDataStruct',
      'DEFAULT_BASE_DELAY_MS',
      'DEFAULT_MAX_DELAY_MS',
      'DEFAULT_MAX_RETRY_ATTEMPTS',
      'EmptyJsonArray',
      'GET_DESCRIPTION',
      'S',
      'abortableDelay',
      'asyncifyMethodGuards',
      'buildMethodGuard',
      'calculateReconnectionBackoff',
      'delay',
      'fetchValidatedJson',
      'fromHex',
      'getGuardAt',
      'getInterfaceMethodGuards',
      'getMethodPayload',
      'ifDefined',
      'installWakeDetector',
      'isCapData',
      'isJsonRpcCall',
      'isJsonRpcMessage',
      'isPrimitive',
      'isTypedArray',
      'isTypedObject',
      'isVatBundle',
      'join',
      'jsonSchemaToStruct',
      'makeCounter',
      'makeDefaultExo',
      'makeDefaultInterface',
      'makeDiscoverableExo',
      'makeGuardedFetch',
      'mergeDisjointRecords',
      'methodArgsToStruct',
      'narrow',
      'pathUnder',
      'prettifySmallcaps',
      'resolveFetchInput',
      'retry',
      'retryWithBackoff',
      'stringify',
      'toHex',
      'waitUntilQuiescent',
    ]);
  });
});
