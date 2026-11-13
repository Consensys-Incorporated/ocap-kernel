import { makeSQLKernelDatabase } from './wasm.ts';
import { describeRecordStore } from '../../test/record-store-suite.ts';

// Kept out of `wasm.test.ts`, whose `vi.mock` replaces sqlite-wasm for the
// whole file.
describeRecordStore(async () => makeSQLKernelDatabase({}));
