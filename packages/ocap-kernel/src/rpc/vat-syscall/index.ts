import type {
  MethodSpecRecord,
  HandlerRecord,
} from '@metamask/kernel-rpc-methods';

import {
  scheduledSyscallHandler,
  scheduledSyscallSpec,
  vatSyscallSpec,
  vatSyscallHandler,
} from './vat-syscall.ts';

export const vatSyscallHandlers = {
  syscall: vatSyscallHandler,
  scheduledSyscall: scheduledSyscallHandler,
} as HandlerRecord<typeof vatSyscallHandler | typeof scheduledSyscallHandler>;

export const vatSyscallMethodSpecs = {
  syscall: vatSyscallSpec,
  scheduledSyscall: scheduledSyscallSpec,
} as MethodSpecRecord<typeof vatSyscallSpec | typeof scheduledSyscallSpec>;

type Handlers = (typeof vatSyscallHandlers)[keyof typeof vatSyscallHandlers];

export type VatSyscallMethod = Handlers['method'];
