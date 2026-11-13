/* oxlint-disable node/no-process-env, node/no-sync, ocap/require-jsdoc, id-denylist */
/**
 * Deploy ERC-4337 + MetaMask delegation contracts to the local Anvil chain.
 *
 * 1. Deploys the deterministic deployer (Nick's Factory) — required by Alto
 *    bundler for deploying its simulation contracts via CREATE2.
 * 2. Uses `deploySmartAccountsEnvironment()` from @metamask/smart-accounts-kit
 *    to deploy EntryPoint, DelegationManager, enforcers, and factory.
 *
 * Writes the deployed addresses to /run/ocap/contracts.json for other
 * services to consume.
 *
 * Usage:
 *   node packages/evm-wallet-experiment/docker/deploy-contracts.mjs
 *
 * Env vars:
 *   EVM_RPC_URL  — JSON-RPC endpoint (default: http://evm:8545)
 */

import { deploySmartAccountsEnvironment } from '@metamask/smart-accounts-kit/utils';
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const RPC_URL = process.env.EVM_RPC_URL || 'http://evm:8545';
const OUTPUT_PATH = '/run/ocap/contracts.json';

// Anvil account #18 (index 18 from test mnemonic) — reserved for contract
// deployment so it doesn't collide with home (0) or away throwaway accounts.
const DEPLOYER_KEY =
  '0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0';

// Nick's deterministic deployer — the standard CREATE2 factory used by ERC-4337
// and Alto bundler. Must be at this exact address for deterministic deployment.
// See: https://github.com/Arachnid/deterministic-deployment-proxy
const NICK_FACTORY_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const NICK_FACTORY_DEPLOYER = '0x3fab184622dc19b6109349b94811493bf2a45362';
// Pre-signed deployment transaction (chain-agnostic, works on any EVM chain)
const NICK_FACTORY_TX =
  '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222';

async function deployNickFactory(publicClient, transport) {
  const code = await publicClient.getCode({ address: NICK_FACTORY_ADDRESS });
  if (code && code !== '0x') {
    console.log('[deploy] Nick factory already deployed.');
    return;
  }

  console.log('[deploy] Deploying deterministic deployer (Nick factory)...');

  // Fund the deployer address (it needs ETH for gas)
  const funder = privateKeyToAccount(DEPLOYER_KEY);
  const funderClient = createWalletClient({
    account: funder,
    chain: foundry,
    transport,
  });
  await funderClient.sendTransaction({
    to: NICK_FACTORY_DEPLOYER,
    value: 100000000000000000n, // 0.1 ETH
  });

  // Send the pre-signed deployment transaction via raw RPC
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendRawTransaction',
      params: [NICK_FACTORY_TX],
    }),
  });
  const result = await response.json();
  if (result.error) {
    throw new Error(
      `Failed to deploy Nick factory: ${JSON.stringify(result.error)}`,
    );
  }
  console.log(`[deploy] Nick factory deployed at ${NICK_FACTORY_ADDRESS}`);
}

async function main() {
  console.log(`[deploy] Deploying contracts to ${RPC_URL}...`);

  const account = privateKeyToAccount(DEPLOYER_KEY);
  const transport = http(RPC_URL);

  const publicClient = createPublicClient({
    chain: foundry,
    transport,
  });

  const walletClient = createWalletClient({
    account,
    chain: foundry,
    transport,
  });

  // Step 1: Deploy the deterministic deployer (needed by Alto bundler)
  await deployNickFactory(publicClient, transport);

  // Step 2: Deploy ERC-4337 + delegation contracts
  const env = await deploySmartAccountsEnvironment(
    walletClient,
    publicClient,
    foundry,
  );

  console.log(`[deploy] EntryPoint:         ${env.EntryPoint}`);
  console.log(`[deploy] DelegationManager:  ${env.DelegationManager}`);
  console.log(`[deploy] SimpleFactory:      ${env.SimpleFactory}`);
  console.log(
    `[deploy] Implementations:    ${JSON.stringify(env.implementations)}`,
  );
  console.log(
    `[deploy] CaveatEnforcers:    ${JSON.stringify(env.caveatEnforcers)}`,
  );

  writeFileSync(OUTPUT_PATH, JSON.stringify(env, null, 2));
  console.log(`[deploy] Addresses written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('[deploy] FATAL:', err);
  process.exit(1);
});
