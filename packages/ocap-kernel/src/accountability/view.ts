import type {
  AccountabilityRecord,
  AccountabilityRecordView,
  CauseView,
} from './types.ts';
import type { KernelStore } from '../store/index.ts';
import type { Cause, Sender } from '../types.ts';

/**
 * A cause as a vat reads it: the record of the delivery to the sender in the
 * crank the cause names, where the kernel wrote one.
 *
 * @param kernelStore - The kernel's store.
 * @param sender - Who issued the send the cause is of.
 * @param cause - The cause.
 * @returns The cause as a vat reads it.
 */
const viewCause = (
  kernelStore: KernelStore,
  sender: Sender,
  cause: Cause,
): CauseView => {
  if (typeof cause !== 'number') {
    return cause;
  }
  const [delivery] = kernelStore.getAccountabilityRecords({
    kind: 'delivery',
    endpoint: sender,
    crank: cause,
    limit: 1,
  });
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
    'cause' in record
      ? {
          ...record,
          cause: viewCause(kernelStore, record.sender, record.cause),
        }
      : record,
  ) as AccountabilityRecordView[];
}
harden(viewRecords);
