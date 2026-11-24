import type {
  AccountabilityRecord,
  AccountabilityRecordView,
  CauseView,
} from './types.ts';
import type { KernelStore } from '../store/index.ts';
import type { Cause, Sender } from '../types.ts';

/**
 * A cause as a vat reads it: the record of the delivery to the endpoint in
 * the crank the cause names, where the kernel wrote one.
 *
 * @param kernelStore - The kernel's store.
 * @param endpoint - Whose delivery the cause names: the sender of a send, or
 * the vat reporting an exercise.
 * @param cause - The cause.
 * @returns The cause as a vat reads it.
 */
const viewCause = (
  kernelStore: KernelStore,
  endpoint: Sender,
  cause: Cause,
): CauseView => {
  if (cause === 'async') {
    return cause;
  }
  const [delivery] = kernelStore.getAccountabilityRecords({
    kind: 'delivery',
    witness: 'kernel',
    endpoint,
    crank: typeof cause === 'number' ? cause : cause.crankNumber,
    limit: 1,
  });
  if (typeof cause !== 'number') {
    return {
      witness: cause.witness,
      ...(delivery === undefined ? {} : { delivery: delivery.seq }),
    };
  }
  return delivery === undefined ? 'unrecorded' : { delivery: delivery.seq };
};

/**
 * Records as a vat reads them.
 *
 * @param kernelStore - The kernel's store.
 * @param records - The records.
 * @returns The records, each as a vat reads it.
 */
export function viewRecords(
  kernelStore: KernelStore,
  records: AccountabilityRecord[],
): AccountabilityRecordView[] {
  return records.map(({ crankNumber: _crankNumber, ...record }) =>
    'cause' in record && record.cause !== undefined
      ? {
          ...record,
          cause: viewCause(
            kernelStore,
            'sender' in record ? record.sender : record.endpoint,
            record.cause,
          ),
        }
      : record,
  ) as AccountabilityRecordView[];
}
harden(viewRecords);
