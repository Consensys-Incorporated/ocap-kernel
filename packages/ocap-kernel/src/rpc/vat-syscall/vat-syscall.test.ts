import { describe, it, expect, vi } from 'vitest';

import { scheduledSyscallHandler, vatSyscallHandler } from './vat-syscall.ts';

describe('vatSyscallHandler', () => {
  it('should initialize a vat', () => {
    const handleSyscall = vi.fn();
    vatSyscallHandler.implementation({ handleSyscall }, [
      'send',
      'test',
      {
        methargs: { body: 'test', slots: [] },
        result: null,
      },
    ]);

    expect(handleSyscall).toHaveBeenCalledTimes(1);
    expect(handleSyscall).toHaveBeenCalledWith([
      'send',
      'test',
      {
        methargs: { body: 'test', slots: [] },
        result: null,
      },
    ]);
  });

  it('should propagate errors from hooks', () => {
    const handleSyscall = vi.fn(() => {
      throw new Error('fake');
    });
    expect(() =>
      vatSyscallHandler.implementation({ handleSyscall }, [
        'send',
        'test',
        {
          methargs: { body: 'test', slots: [] },
          result: null,
        },
      ]),
    ).toThrow('fake');
  });
});

describe('scheduledSyscallHandler', () => {
  it('hands the syscall over with the crank that scheduled it', () => {
    const handleSyscall = vi.fn();
    scheduledSyscallHandler.implementation(
      { handleSyscall },
      { syscall: ['subscribe', 'p-1'], cause: 7 },
    );
    expect(handleSyscall).toHaveBeenCalledWith(['subscribe', 'p-1'], 7);
  });
});
