import { describe, expect, it } from 'vitest';

import * as indexModule from './index.ts';

describe('index', () => {
  it('has the expected exports', () => {
    expect(Object.keys(indexModule).sort()).toStrictEqual([
      'PlatformServicesClient',
      'PlatformServicesServer',
      'connectToKernel',
      'createCommsQueryString',
      'getCapTPMessage',
      'getCommsParamsFromCurrentLocation',
      'handleConsoleForwardMessage',
      'isCapTPNotification',
      'isConsoleForwardMessage',
      'isIframeWindow',
      'makeBackgroundCapTP',
      'makeCapTPNotification',
      'makeIframeVatWorker',
      'parseCommsQueryString',
      'receiveInternalConnections',
      'rpcHandlers',
      'rpcMethodSpecs',
      'setupConsoleForwarding',
    ]);
  });
});
