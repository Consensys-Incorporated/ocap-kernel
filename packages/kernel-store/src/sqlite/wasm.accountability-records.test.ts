import { makeSQLKernelDatabase } from './wasm.ts';
import { describeAccountabilityRecordStore } from '../../test/accountability-record-store-suite.ts';

// Kept out of `wasm.test.ts`, whose `vi.mock` replaces sqlite-wasm for the
// whole file.
describeAccountabilityRecordStore(async () => makeSQLKernelDatabase({}));
