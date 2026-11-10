/* oxlint-disable node/no-process-env */
/**
 * Shared delegation flow for the Docker stack: create on home, push to away over CapTP.
 * Used by `docker/create-delegation.mjs`.
 */

import { dockerConfig } from '../../../../docker/docker-e2e-stack-constants.mjs';

const NATIVE_TRANSFER_ENFORCER = '0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320';

/**
 * Prefer smart-account delegate when present, else EOA delegate from away info.
 *
 * @param {Record<string, unknown>} awayInfo - Parsed `docker-delegation-away.json`.
 * @returns {string} On-chain delegate address for the away wallet.
 */
export function resolveDelegateForAway(awayInfo) {
  return awayInfo.smartAccountAddress || awayInfo.delegateAddress;
}

/**
 * `delegate` for `createDelegation` given Docker stack mode.
 * Peer-relay redeems on the home wallet, so DelegationManager sees
 * `msg.sender` = home; leaf `delegate` must match (see DelegationManager.redeemDelegations).
 *
 * @param {object} options - Arguments.
 * @param {string} options.delegationMode - `bundler-7702`, `bundler-hybrid`, or `peer-relay`.
 * @param {Record<string, unknown>} options.homeInfo - Parsed `docker-delegation-home.json`.
 * @param {Record<string, unknown>} options.awayInfo - Parsed `docker-delegation-away.json`.
 * @returns {string} Address to pass as `delegate` to `createDelegation`.
 */
export function resolveOnChainDelegateForDockerMode(options) {
  const { delegationMode, homeInfo, awayInfo } = options;
  if (delegationMode === 'peer-relay') {
    const addr = homeInfo.smartAccountAddress || homeInfo.address;
    if (!addr || typeof addr !== 'string') {
      throw new Error(
        'peer-relay requires home delegation context smartAccountAddress or address',
      );
    }
    return addr;
  }
  return resolveDelegateForAway(awayInfo);
}

/**
 * Build caveat list from env. When `CAVEAT_ETH_LIMIT` is set, caps native-token spend.
 *
 * @returns {Array<Record<string, unknown>>} Caveat objects for `createDelegation`.
 */
export function buildCaveatsFromEnv() {
  const caveats = [];
  const ethLimit = process.env.CAVEAT_ETH_LIMIT;
  if (ethLimit) {
    const wei = BigInt(Math.floor(Number(ethLimit) * 1e18));
    const terms = `0x${wei.toString(16).padStart(64, '0')}`;
    caveats.push({
      type: 'nativeTokenTransferAmount',
      enforcer: NATIVE_TRANSFER_ENFORCER,
      terms,
    });
  }
  return caveats;
}

/**
 * Create a signed delegation on the home coordinator for the away delegate.
 *
 * @param {object} options - Arguments.
 * @param {(method: string, args: unknown[]) => Promise<unknown>} options.callHome - Home coordinator `callVat` wrapper.
 * @param {Record<string, unknown>} options.awayInfo - Parsed `docker-delegation-away.json`.
 * @param {Record<string, unknown>} [options.homeInfo] - Parsed `docker-delegation-home.json` (required for peer-relay).
 * @param {string} [options.delegationMode] - Defaults to `process.env.DELEGATION_MODE` or `bundler-7702`.
 * @param {Array<Record<string, unknown>>} [options.caveats] - Optional caveats (default none).
 * @returns {Promise<Record<string, unknown>>} Created delegation record from the coordinator.
 */
export async function createDelegationForDockerStack({
  callHome,
  awayInfo,
  homeInfo,
  delegationMode = process.env.DELEGATION_MODE ?? 'bundler-7702',
  caveats = [],
}) {
  const delegate = resolveOnChainDelegateForDockerMode({
    delegationMode,
    homeInfo: homeInfo ?? {},
    awayInfo,
  });
  return callHome('createDelegation', [
    { delegate, caveats, chainId: dockerConfig.anvilChainId },
  ]);
}

/**
 * Push a signed delegation to the peer away wallet (CapTP), from the home coordinator.
 *
 * @param {(method: string, args: unknown[]) => Promise<unknown>} callHome - Home coordinator `callVat` wrapper.
 * @param {Record<string, unknown>} delegation - Delegation object from `createDelegation`.
 */
export async function pushDelegationOverPeer(callHome, delegation) {
  await callHome('pushDelegationToAway', [delegation]);
}
