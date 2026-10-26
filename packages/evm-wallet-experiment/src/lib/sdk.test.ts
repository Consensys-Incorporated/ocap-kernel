import { describe, it, expect } from 'vitest';

import { encodeAllowedTargets, makeCaveat } from './caveats.ts';
import { finalizeDelegation, makeDelegation } from './delegation.ts';
import {
  buildBatchExecuteCallData,
  buildSdkBatchRedeemCallData,
  buildSdkDisableCallData,
  buildSdkRedeemCallData,
  createSdkExecution,
  encodeSdkDelegations,
  getDelegationManagerAddress,
  getEnforcerAddresses,
  isEip7702Delegated,
  prepareUserOpTypedData,
  resolveEnvironment,
  toSdkDelegation,
} from './sdk.ts';
import type { Address, Hex } from '../types.ts';

const ALICE = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address;
const BOB = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const TARGET = '0x1234567890abcdef1234567890abcdef12345678' as Address;
const SEPOLIA_CHAIN_ID = 11155111;

describe('lib/sdk', () => {
  describe('resolveEnvironment', () => {
    it('returns valid Sepolia environment', () => {
      const env = resolveEnvironment(SEPOLIA_CHAIN_ID);

      expect(env.DelegationManager).toMatch(/^0x[\da-f]{40}$/iu);
      expect(env.EntryPoint).toMatch(/^0x[\da-f]{40}$/iu);
      expect(env.SimpleFactory).toMatch(/^0x[\da-f]{40}$/iu);
      expect(env.implementations).toBeDefined();
      expect(env.caveatEnforcers).toBeDefined();
    });

    it('throws for unsupported chain', () => {
      expect(() => resolveEnvironment(99999)).toThrow('No contracts found');
    });
  });

  describe('getDelegationManagerAddress', () => {
    it('returns a valid address for Sepolia', () => {
      const address = getDelegationManagerAddress(SEPOLIA_CHAIN_ID);
      expect(address).toMatch(/^0x[\da-f]{40}$/iu);
    });
  });

  describe('getEnforcerAddresses', () => {
    it('returns enforcer addresses for Sepolia', () => {
      const enforcers = getEnforcerAddresses(SEPOLIA_CHAIN_ID);

      expect(enforcers.allowedTargets).toMatch(/^0x[\da-f]{40}$/iu);
      expect(enforcers.allowedMethods).toMatch(/^0x[\da-f]{40}$/iu);
      expect(enforcers.valueLte).toMatch(/^0x[\da-f]{40}$/iu);
      expect(enforcers.erc20TransferAmount).toMatch(/^0x[\da-f]{40}$/iu);
      expect(enforcers.limitedCalls).toMatch(/^0x[\da-f]{40}$/iu);
      expect(enforcers.timestamp).toMatch(/^0x[\da-f]{40}$/iu);
    });
  });

  describe('toSdkDelegation', () => {
    it('converts our delegation to SDK format', () => {
      const delegation = finalizeDelegation(
        makeDelegation({
          delegator: ALICE,
          delegate: BOB,
          caveats: [
            makeCaveat({
              type: 'allowedTargets',
              terms: encodeAllowedTargets([TARGET]),
            }),
          ],
          chainId: 1,
          salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        }),
        '0xdeadbeef' as Hex,
      );

      const sdkDelegation = toSdkDelegation(delegation);

      expect(sdkDelegation.delegate).toBe(delegation.delegate);
      expect(sdkDelegation.delegator).toBe(delegation.delegator);
      expect(sdkDelegation.authority).toBe(delegation.authority);
      expect(sdkDelegation.salt).toBe(delegation.salt);
      expect(sdkDelegation.signature).toBe(delegation.signature);
      expect(sdkDelegation.caveats).toHaveLength(1);
      expect(sdkDelegation.caveats[0]?.enforcer).toBe(
        delegation.caveats[0]?.enforcer,
      );
      expect(sdkDelegation.caveats[0]?.terms).toBe(
        delegation.caveats[0]?.terms,
      );
      expect(sdkDelegation.caveats[0]?.args).toBe('0x');
    });

    it('defaults signature to 0x for unsigned delegations', () => {
      const delegation = makeDelegation({
        delegator: ALICE,
        delegate: BOB,
        caveats: [],
        chainId: 1,
      });

      const sdkDelegation = toSdkDelegation(delegation);
      expect(sdkDelegation.signature).toBe('0x');
    });
  });

  describe('encodeSdkDelegations', () => {
    it('produces valid ABI output', () => {
      const delegation = finalizeDelegation(
        makeDelegation({
          delegator: ALICE,
          delegate: BOB,
          caveats: [
            makeCaveat({
              type: 'allowedTargets',
              terms: encodeAllowedTargets([TARGET]),
            }),
          ],
          chainId: 1,
          salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        }),
        '0xdeadbeef' as Hex,
      );

      const encoded = encodeSdkDelegations([delegation]);

      expect(encoded).toMatch(/^0x/u);
      expect(encoded.length).toBeGreaterThan(2);
    });

    it('encodes an empty array', () => {
      const encoded = encodeSdkDelegations([]);

      expect(encoded).toMatch(/^0x/u);
    });
  });

  describe('buildSdkRedeemCallData', () => {
    it('produces callData starting with redeemDelegations selector', () => {
      const delegation = finalizeDelegation(
        makeDelegation({
          delegator: ALICE,
          delegate: BOB,
          caveats: [],
          chainId: 1,
          salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        }),
        '0xdeadbeef' as Hex,
      );

      const callData = buildSdkRedeemCallData({
        delegations: [delegation],
        execution: {
          target: TARGET,
          value: '0x0' as Hex,
          callData: '0x' as Hex,
        },
        chainId: 11155111,
      });

      // Wrapped in DeleGatorCore.execute (selector 0x5c1c6dcd)
      expect(callData).toMatch(/^0x5c1c6dcd/u);
      expect(callData.length).toBeGreaterThan(10);
    });

    it('produces non-empty callData', () => {
      const delegation = finalizeDelegation(
        makeDelegation({
          delegator: ALICE,
          delegate: BOB,
          caveats: [],
          chainId: 1,
          salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        }),
        '0xdeadbeef' as Hex,
      );

      const callData = buildSdkRedeemCallData({
        delegations: [delegation],
        execution: {
          target: TARGET,
          value: '0x0' as Hex,
          callData: '0xa9059cbb' as Hex,
        },
        chainId: 11155111,
      });

      expect(callData.length).toBeGreaterThan(10);
    });
  });

  describe('buildSdkDisableCallData', () => {
    it('produces callData wrapped in DeleGatorCore.execute targeting DelegationManager', () => {
      const delegation = finalizeDelegation(
        makeDelegation({
          delegator: ALICE,
          delegate: BOB,
          caveats: [],
          chainId: 1,
          salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        }),
        '0xdeadbeef' as Hex,
      );

      const callData = buildSdkDisableCallData({
        delegation,
        chainId: SEPOLIA_CHAIN_ID,
      });

      // Wrapped in DeleGatorCore.execute (selector 0x5c1c6dcd)
      expect(callData).toMatch(/^0x5c1c6dcd/u);

      // The inner call targets the DelegationManager address
      const env = resolveEnvironment(SEPOLIA_CHAIN_ID);
      const dmAddrLower = env.DelegationManager.toLowerCase().slice(2);
      expect(callData.toLowerCase()).toContain(dmAddrLower);

      // The inner call uses disableDelegation (selector 0x49934047)
      expect(callData.toLowerCase()).toContain('49934047');
    });
  });

  describe('buildSdkBatchRedeemCallData', () => {
    it('produces callData wrapped in DeleGatorCore.execute with batch mode', () => {
      const delegation = finalizeDelegation(
        makeDelegation({
          delegator: ALICE,
          delegate: BOB,
          caveats: [],
          chainId: 1,
          salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        }),
        '0xdeadbeef' as Hex,
      );

      const callData = buildSdkBatchRedeemCallData({
        delegations: [delegation],
        executions: [
          { target: TARGET, value: '0x0' as Hex, callData: '0x' as Hex },
          {
            target: TARGET,
            value: '0x0' as Hex,
            callData: '0xa9059cbb' as Hex,
          },
        ],
        chainId: SEPOLIA_CHAIN_ID,
      });

      // Wrapped in DeleGatorCore.execute (selector 0x5c1c6dcd)
      expect(callData).toMatch(/^0x5c1c6dcd/u);
      expect(callData.length).toBeGreaterThan(10);
    });

    it('encodes the DelegationManager as the inner target', () => {
      const delegation = finalizeDelegation(
        makeDelegation({
          delegator: ALICE,
          delegate: BOB,
          caveats: [],
          chainId: 1,
          salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        }),
        '0xdeadbeef' as Hex,
      );

      const callData = buildSdkBatchRedeemCallData({
        delegations: [delegation],
        executions: [
          { target: TARGET, value: '0x0' as Hex, callData: '0x' as Hex },
        ],
        chainId: SEPOLIA_CHAIN_ID,
      });

      const env = resolveEnvironment(SEPOLIA_CHAIN_ID);
      const dmAddrLower = env.DelegationManager.toLowerCase().slice(2);
      expect(callData.toLowerCase()).toContain(dmAddrLower);
    });
  });

  describe('buildBatchExecuteCallData', () => {
    it('produces callData using executeWithMode selector', () => {
      const callData = buildBatchExecuteCallData({
        executions: [
          { target: TARGET, value: '0x0' as Hex, callData: '0x' as Hex },
          { target: ALICE, value: '0x0' as Hex, callData: '0xa9059cbb' as Hex },
        ],
      });

      // DeleGatorCore.executeWithMode selector: 0xe9ae5c53
      expect(callData).toMatch(/^0xe9ae5c53/u);
      expect(callData.length).toBeGreaterThan(10);
    });

    it('encodes target addresses in the callData', () => {
      const callData = buildBatchExecuteCallData({
        executions: [
          { target: TARGET, value: '0x0' as Hex, callData: '0x' as Hex },
          { target: ALICE, value: '0x0' as Hex, callData: '0x' as Hex },
        ],
      });

      expect(callData.toLowerCase()).toContain(TARGET.toLowerCase().slice(2));
      expect(callData.toLowerCase()).toContain(ALICE.toLowerCase().slice(2));
    });
  });

  describe('createSdkExecution', () => {
    it('creates an execution struct with defaults', () => {
      const execution = createSdkExecution({ target: TARGET });

      expect(execution.target).toBe(TARGET);
      expect(execution.value).toBe(0n);
      expect(execution.callData).toBe('0x');
    });

    it('creates an execution struct with explicit values', () => {
      const execution = createSdkExecution({
        target: TARGET,
        value: 1000000000000000000n,
        callData: '0xa9059cbb' as Hex,
      });

      expect(execution.target).toBe(TARGET);
      expect(execution.value).toBe(1000000000000000000n);
      expect(execution.callData).toBe('0xa9059cbb');
    });
  });

  describe('isEip7702Delegated', () => {
    it('returns true for valid 7702 designator with correct implementation', () => {
      const env = resolveEnvironment(SEPOLIA_CHAIN_ID);
      const implAddress = (
        env.implementations as Record<string, string | undefined>
      ).EIP7702StatelessDeleGatorImpl;
      // EIP-7702 designator: 0xef0100 + 20-byte address (no 0x prefix on address part)
      const code = `0xef0100${implAddress?.slice(2).toLowerCase()}`;
      expect(isEip7702Delegated(code, SEPOLIA_CHAIN_ID)).toBe(true);
    });

    it('returns false for empty code', () => {
      expect(isEip7702Delegated('0x', SEPOLIA_CHAIN_ID)).toBe(false);
    });

    it('returns false for wrong prefix', () => {
      expect(
        isEip7702Delegated(
          '0xef020063c0c19a282a1b52b07dd5a65b58948a07dae32b',
          SEPOLIA_CHAIN_ID,
        ),
      ).toBe(false);
    });

    it('returns false for wrong implementation address', () => {
      expect(
        isEip7702Delegated(
          '0xef01000000000000000000000000000000000000000000',
          SEPOLIA_CHAIN_ID,
        ),
      ).toBe(false);
    });

    it('returns false for code with wrong length', () => {
      expect(isEip7702Delegated('0xef0100abcd', SEPOLIA_CHAIN_ID)).toBe(false);
    });

    it('handles case-insensitive comparison', () => {
      const env = resolveEnvironment(SEPOLIA_CHAIN_ID);
      const implAddress = (
        env.implementations as Record<string, string | undefined>
      ).EIP7702StatelessDeleGatorImpl;
      // Use uppercase hex for the designator
      const code = `0xEF0100${implAddress?.slice(2).toUpperCase()}`;
      expect(isEip7702Delegated(code, SEPOLIA_CHAIN_ID)).toBe(true);
    });
  });

  describe('prepareUserOpTypedData', () => {
    const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
    const SMART_ACCOUNT =
      '0xcccccccccccccccccccccccccccccccccccccccc' as Address;

    it('produces typed data with HybridDeleGator domain by default', () => {
      const typedData = prepareUserOpTypedData({
        userOp: {
          sender: SMART_ACCOUNT,
          nonce: '0x0',
          callData: '0x',
          callGasLimit: '0x50000',
          verificationGasLimit: '0x60000',
          preVerificationGas: '0x10000',
          maxFeePerGas: '0x77359400',
          maxPriorityFeePerGas: '0x3b9aca00',
          signature: '0x',
        },
        entryPoint: ENTRY_POINT,
        chainId: SEPOLIA_CHAIN_ID,
        smartAccountAddress: SMART_ACCOUNT,
      });

      expect(typedData.domain.name).toBe('HybridDeleGator');
      expect(typedData.domain.version).toBe('1');
      expect(typedData.domain.chainId).toBe(SEPOLIA_CHAIN_ID);
      expect(typedData.domain.verifyingContract).toBe(SMART_ACCOUNT);
      expect(typedData.primaryType).toBe('PackedUserOperation');
      expect(typedData.types).toHaveProperty('PackedUserOperation');
      expect(typedData.message).toHaveProperty('entryPoint', ENTRY_POINT);
    });

    it('uses custom domain name for EIP7702StatelessDeleGator', () => {
      const typedData = prepareUserOpTypedData({
        userOp: {
          sender: SMART_ACCOUNT,
          nonce: '0x0',
          callData: '0x',
          callGasLimit: '0x50000',
          verificationGasLimit: '0x60000',
          preVerificationGas: '0x10000',
          maxFeePerGas: '0x77359400',
          maxPriorityFeePerGas: '0x3b9aca00',
          signature: '0x',
        },
        entryPoint: ENTRY_POINT,
        chainId: SEPOLIA_CHAIN_ID,
        smartAccountAddress: SMART_ACCOUNT,
        smartAccountName: 'EIP7702StatelessDeleGator',
      });

      expect(typedData.domain.name).toBe('EIP7702StatelessDeleGator');
    });
  });
});
