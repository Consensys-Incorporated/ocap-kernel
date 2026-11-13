import { makeSQLKernelDatabase } from './nodejs.ts';
import { describeRecordStore } from '../../test/record-store-suite.ts';

// Kept out of `nodejs.test.ts`, whose `vi.mock` replaces better-sqlite3 for
// the whole file.
describeRecordStore(async () => makeSQLKernelDatabase({}));
