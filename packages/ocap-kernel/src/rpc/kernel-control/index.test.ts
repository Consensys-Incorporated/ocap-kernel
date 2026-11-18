import { describe, it, expect } from 'vitest';

import { clearStateHandler, clearStateSpec } from './clear-state.ts';
import {
  collectGarbageHandler,
  collectGarbageSpec,
} from './collect-garbage.ts';
import {
  executeDBQueryHandler,
  executeDBQuerySpec,
} from './execute-db-query.ts';
import { getStatusHandler, getStatusSpec } from './get-status.ts';
import { rpcHandlers, rpcMethodSpecs } from './index.ts';
import {
  initRemoteCommsHandler,
  initRemoteCommsSpec,
} from './init-remote-comms.ts';
import { isRevokedHandler, isRevokedSpec } from './is-revoked.ts';
import { issueOcapURLHandler, issueOcapURLSpec } from './issue-ocap-url.ts';
import {
  launchSubclusterHandler,
  launchSubclusterSpec,
} from './launch-subcluster.ts';
import { pingVatHandler, pingVatSpec } from './ping-vat.ts';
import { queueMessageHandler, queueMessageSpec } from './queue-message.ts';
import { redeemOcapURLHandler, redeemOcapURLSpec } from './redeem-ocap-url.ts';
import { releaseResultHandler, releaseResultSpec } from './release-result.ts';
import {
  registerLocationHintsHandler,
  registerLocationHintsSpec,
} from './register-location-hints.ts';
import { restartVatHandler, restartVatSpec } from './restart-vat.ts';
import { revokeHandler, revokeSpec } from './revoke.ts';
import {
  terminateAllVatsHandler,
  terminateAllVatsSpec,
} from './terminate-all-vats.ts';
import {
  terminateSubclusterHandler,
  terminateSubclusterSpec,
} from './terminate-subcluster.ts';
import { terminateVatHandler, terminateVatSpec } from './terminate-vat.ts';

describe('handlers/index', () => {
  it('should export all handler functions', () => {
    expect(rpcHandlers).toStrictEqual({
      clearState: clearStateHandler,
      executeDBQuery: executeDBQueryHandler,
      getStatus: getStatusHandler,
      initRemoteComms: initRemoteCommsHandler,
      issueOcapURL: issueOcapURLHandler,
      pingVat: pingVatHandler,
      redeemOcapURL: redeemOcapURLHandler,
      registerLocationHints: registerLocationHintsHandler,
      restartVat: restartVatHandler,
      revoke: revokeHandler,
      isRevoked: isRevokedHandler,
      queueMessage: queueMessageHandler,
      releaseResult: releaseResultHandler,
      terminateAllVats: terminateAllVatsHandler,
      collectGarbage: collectGarbageHandler,
      terminateVat: terminateVatHandler,
      launchSubcluster: launchSubclusterHandler,
      terminateSubcluster: terminateSubclusterHandler,
    });
  });

  it('should have all handlers with the correct method property', () => {
    const handlerEntries = Object.entries(rpcHandlers);

    handlerEntries.forEach(([key, handler]) => {
      expect(handler).toHaveProperty('method');
      expect(handler.method).toBe(key);
    });
  });

  it('should export all method specs', () => {
    expect(rpcMethodSpecs).toStrictEqual({
      clearState: clearStateSpec,
      executeDBQuery: executeDBQuerySpec,
      getStatus: getStatusSpec,
      initRemoteComms: initRemoteCommsSpec,
      issueOcapURL: issueOcapURLSpec,
      pingVat: pingVatSpec,
      redeemOcapURL: redeemOcapURLSpec,
      registerLocationHints: registerLocationHintsSpec,
      restartVat: restartVatSpec,
      revoke: revokeSpec,
      isRevoked: isRevokedSpec,
      queueMessage: queueMessageSpec,
      releaseResult: releaseResultSpec,
      terminateAllVats: terminateAllVatsSpec,
      collectGarbage: collectGarbageSpec,
      terminateVat: terminateVatSpec,
      launchSubcluster: launchSubclusterSpec,
      terminateSubcluster: terminateSubclusterSpec,
    });
  });

  it('should have the same keys as handlers', () => {
    expect(Object.keys(rpcMethodSpecs).sort()).toStrictEqual(
      Object.keys(rpcHandlers).sort(),
    );
  });
});
