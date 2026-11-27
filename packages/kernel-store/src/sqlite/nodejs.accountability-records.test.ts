import { makeSQLKernelDatabase } from './nodejs.ts';
import { describeAccountabilityRecordStore } from '../../test/accountability-record-store-suite.ts';

// Kept out of `nodejs.test.ts`, whose `vi.mock` replaces better-sqlite3 for
// the whole file.
describeAccountabilityRecordStore(async () => makeSQLKernelDatabase({}));
