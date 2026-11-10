import type {
  VatSyscallObject,
  VatSyscallResult,
  VatOneResolution,
} from '@agoric/swingset-liveslots';
import type { CapData } from '@endo/marshal';
import type { KVStore } from '@metamask/kernel-store';
import type { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { makeSupervisorSyscall } from './syscall.ts';
import type { VatSupervisor } from '../vats/VatSupervisor.ts';

describe('syscall', () => {
  // Mock supervisor that records syscalls and returns predefined results
  const createMockSupervisor = (): VatSupervisor => {
    const mockSupervisor = {
      executeSyscall: vi.fn((_vso: VatSyscallObject): VatSyscallResult => [
        'ok',
        null,
      ]),
    } as unknown as VatSupervisor;
    return mockSupervisor;
  };

  // Mock KV store for testing vatstore operations
  const createMockKVStore = (): KVStore => {
    const store = new Map<string, string>();
    const mockKVStore = {
      get: vi.fn((key: string) => store.get(key)),
      getNextKey: vi.fn((priorKey: string) => {
        const keys = Array.from(store.keys()).sort();
        const index = keys.indexOf(priorKey);
        return index >= 0 && index < keys.length - 1
          ? keys[index + 1]
          : undefined;
      }),
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn((key: string) => {
        store.delete(key);
      }),
    } as unknown as KVStore;
    return mockKVStore;
  };

  describe('makeSupervisorSyscall', () => {
    it('creates a syscall object with all required methods', () => {
      const supervisor = createMockSupervisor();
      const kv = createMockKVStore();
      const syscall = makeSupervisorSyscall(supervisor, kv);

      expect(syscall).toHaveProperty('send');
      expect(syscall).toHaveProperty('subscribe');
      expect(syscall).toHaveProperty('resolve');
      expect(syscall).toHaveProperty('exit');
      expect(syscall).toHaveProperty('dropImports');
      expect(syscall).toHaveProperty('retireImports');
      expect(syscall).toHaveProperty('retireExports');
      expect(syscall).toHaveProperty('abandonExports');
      expect(syscall).toHaveProperty('callNow');
      expect(syscall).toHaveProperty('vatstoreGet');
      expect(syscall).toHaveProperty('vatstoreGetNextKey');
      expect(syscall).toHaveProperty('vatstoreSet');
      expect(syscall).toHaveProperty('vatstoreDelete');
    });

    describe('syscall methods', () => {
      it('handles send syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const target = 'ko1';
        const methargs: CapData<string> = { body: '[]', slots: [] };
        const result = 'kp1';

        syscall.send(target, methargs, result);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'send',
          target,
          { methargs, result },
        ]);
      });

      it('handles subscribe syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const vpid = 'kp1';
        syscall.subscribe(vpid);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'subscribe',
          vpid,
        ]);
      });

      it('handles resolve syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const resolutions: VatOneResolution[] = [
          ['kp1', false, { body: '[]', slots: [] }],
        ];
        syscall.resolve(resolutions);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'resolve',
          resolutions,
        ]);
      });

      it('handles exit syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const isFailure = true;
        const info: CapData<string> = { body: '[]', slots: [] };
        syscall.exit(isFailure, info);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'exit',
          isFailure,
          info,
        ]);
      });

      it('handles dropImports syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const vrefs = ['ko1', 'ko2'];
        syscall.dropImports(vrefs);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'dropImports',
          vrefs,
        ]);
      });

      it('handles retireImports syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const vrefs = ['ko1', 'ko2'];
        syscall.retireImports(vrefs);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'retireImports',
          vrefs,
        ]);
      });

      it('handles retireExports syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const vrefs = ['ko1', 'ko2'];
        syscall.retireExports(vrefs);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'retireExports',
          vrefs,
        ]);
      });

      it('handles abandonExports syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        const vrefs = ['ko1', 'ko2'];
        syscall.abandonExports(vrefs);

        expect(supervisor.executeSyscall).toHaveBeenCalledWith([
          'abandonExports',
          vrefs,
        ]);
      });

      it('throws on callNow syscall', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        expect(() => syscall.callNow('ko1', 'method', [])).toThrow(
          'callNow not supported (we have no devices)',
        );
      });

      it('calls logger.warn and then throws if supervisor.syscall fails', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const logger = {
          warn: vi.fn(),
        } as unknown as Logger;
        const syscall = makeSupervisorSyscall(supervisor, kv, logger);

        const testError = new Error('supervisor error');

        vi.spyOn(supervisor, 'executeSyscall').mockImplementationOnce(() => {
          throw testError;
        });

        expect(() => syscall.send('ko1', { body: '[]', slots: [] })).toThrow(
          'supervisor error',
        );

        expect(logger.warn).toHaveBeenCalledWith(
          'supervisor got error during syscall:',
          testError,
        );
      });
    });

    describe('vatstore methods', () => {
      it('handles vatstoreGet', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        kv.set('test-key', 'test-value');
        const result = syscall.vatstoreGet('test-key');

        expect(result).toBe('test-value');
        expect(kv.get).toHaveBeenCalledWith('test-key');
      });

      it('handles vatstoreGetNextKey', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        kv.set('key1', 'value1');
        kv.set('key2', 'value2');
        const result = syscall.vatstoreGetNextKey('key1');

        expect(result).toBe('key2');
        expect(kv.getNextKey).toHaveBeenCalledWith('key1');
      });

      it('handles vatstoreSet', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        syscall.vatstoreSet('test-key', 'test-value');

        expect(kv.set).toHaveBeenCalledWith('test-key', 'test-value');
        expect(kv.get('test-key')).toBe('test-value');
      });

      it('handles vatstoreDelete', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        kv.set('test-key', 'test-value');
        syscall.vatstoreDelete('test-key');

        expect(kv.delete).toHaveBeenCalledWith('test-key');
        expect(kv.get('test-key')).toBeUndefined();
      });
    });

    describe('error handling', () => {
      it('throws on supervisor error', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        vi.spyOn(supervisor, 'executeSyscall').mockImplementationOnce(() => {
          throw new Error('supervisor error');
        });

        expect(() => syscall.send('ko1', { body: '[]', slots: [] })).toThrow(
          'supervisor error',
        );
      });

      it('throws on syscall error result', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        vi.spyOn(supervisor, 'executeSyscall').mockImplementationOnce(() => {
          return ['error', 'syscall failed'];
        });

        expect(() => syscall.send('ko1', { body: '[]', slots: [] })).toThrow(
          'syscall.send failed: syscall failed',
        );
      });

      it('throws on unknown result type', () => {
        const supervisor = createMockSupervisor();
        const kv = createMockKVStore();
        const syscall = makeSupervisorSyscall(supervisor, kv);

        vi.spyOn(supervisor, 'executeSyscall').mockImplementationOnce(() => {
          return ['unknown' as 'ok', null];
        });

        expect(() => syscall.send('ko1', { body: '[]', slots: [] })).toThrow(
          'unknown syscall result type "unknown"',
        );
      });
    });
  });
});
