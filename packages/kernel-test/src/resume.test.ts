import type { CapData } from '@endo/marshal';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { kunser } from '@metamask/ocap-kernel';
import type { KRef, VatId } from '@metamask/ocap-kernel';
import { describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runResume,
  sortLogs,
  extractTestLogs,
} from './utils.ts';

const testSubcluster = {
  bootstrap: 'alice',
  forceReset: true,
  vats: {
    alice: {
      bundleSpec: getBundleSpec('resume-vat'),
      parameters: {
        name: 'Alice',
      },
    },
    bob: {
      bundleSpec: getBundleSpec('resume-vat'),
      parameters: {
        name: 'Bob',
      },
    },
    carol: {
      bundleSpec: getBundleSpec('resume-vat'),
      parameters: {
        name: 'Carol',
      },
    },
  },
};

const bootstrapReference = [
  `Alice: saving name`,
  `Alice: start count: 1`,
  `Bob: saving name`,
  `Bob: start count: 1`,
  `Carol: saving name`,
  `Carol: start count: 1`,
  `Alice: bootstrap()`,
  `Bob: intro()`,
  `Carol: intro()`,
  `Bob: greet('hello from Alice')`,
  `Carol: greet('hello from Alice')`,
  `Alice: Bob answers greeting: 'Bob returns your greeting 'hello from Alice''`,
  `Alice: Carol answers greeting: 'Carol returns your greeting 'hello from Alice''`,
  `Alice: end bootstrap`,
];
const aliceRestartReference = [
  `Alice: saved name is Alice`,
  `Alice: start count: 2`,
];
const aliceResumeReference = [
  `Alice: resume()`,
  `Alice: resumed vat is bootstrap`,
  `Bob: greet('hello again from Alice')`,
  `Carol: greet('hello again from Alice')`,
  `Alice: Bob answers greeting: 'Bob returns your greeting 'hello again from Alice''`,
  `Alice: Carol answers greeting: 'Carol returns your greeting 'hello again from Alice''`,
  `Alice: end resume`,
];
// prettier-ignore
const bobRestartReference = [
  `Bob: saved name is Bob`,
  `Bob: start count: 2`,
];
const bobResumeReference = [
  `Bob: resume()`,
  `Bob: resumed vat is not bootstrap`,
  `Alice: greet('hello boot vat from Bob')`,
  `Bob: boot vat returns greeting with 'Alice returns your greeting 'hello boot vat from Bob''`,
  `Bob: end resume`,
];
const carolRestartReference = [
  `Carol: saved name is Carol`,
  `Carol: start count: 2`,
];
const carolResumeReference = [
  `Carol: resume()`,
  `Carol: resumed vat is not bootstrap`,
  `Alice: greet('hello boot vat from Carol')`,
  `Carol: boot vat returns greeting with 'Alice returns your greeting 'hello boot vat from Carol''`,
  `Carol: end resume`,
];
const reference = sortLogs([
  ...bootstrapReference,
  ...aliceRestartReference,
  ...bobRestartReference,
  ...carolRestartReference,
  ...aliceResumeReference,
  ...bobResumeReference,
  ...carolResumeReference,
]);

describe('restarting vats', async () => {
  it('exercise restart vats individually', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { logger, entries } = makeTestLogger();
    const kernel = await makeKernel(kernelDatabase, true, logger);
    // Use launchSubcluster directly to get vatRootKrefs: concurrent vat launch
    // means ko<N> assignment order depends on worker startup speed.
    const { bootstrapResult, vatRootKrefs } =
      await kernel.launchSubcluster(testSubcluster);
    await waitUntilQuiescent();
    expect(kunser(bootstrapResult as CapData<KRef>)).toBe('bootstrap Alice');
    const v1Root = vatRootKrefs.alice!;
    const v2Root = vatRootKrefs.bob!;
    const v3Root = vatRootKrefs.carol!;
    await kernel.restartVat('v1' as VatId);
    await kernel.restartVat('v2' as VatId);
    await kernel.restartVat('v3' as VatId);
    const resumeResultA = await runResume(kernel, v1Root);
    expect(resumeResultA).toBe('resume Alice');
    const resumeResultB = await runResume(kernel, v2Root);
    expect(resumeResultB).toBe('resume Bob');
    const resumeResultC = await runResume(kernel, v3Root);
    expect(resumeResultC).toBe('resume Carol');

    await waitUntilQuiescent(1000);
    const vatLogs = extractTestLogs(entries, 'v1', 'v2', 'v3');
    expect(sortLogs(vatLogs)).toStrictEqual(reference);
  });

  it('exercise restart kernel', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { logger: logger1, entries: entries1 } = makeTestLogger();
    const kernel1 = await makeKernel(kernelDatabase, true, logger1);
    // Capture vatRootKrefs from first kernel: ko<N> refs are stable across
    // kernel restarts because they are persisted in the kernel store.
    const { bootstrapResult, vatRootKrefs } =
      await kernel1.launchSubcluster(testSubcluster);
    await waitUntilQuiescent();
    expect(kunser(bootstrapResult as CapData<KRef>)).toBe('bootstrap Alice');
    const v1Root = vatRootKrefs.alice!;
    const v2Root = vatRootKrefs.bob!;
    const v3Root = vatRootKrefs.carol!;
    const { logger: logger2, entries: entries2 } = makeTestLogger();
    const kernel2 = await makeKernel(kernelDatabase, false, logger2);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const resumeResultA = await runResume(kernel2, v1Root);
    expect(resumeResultA).toBe('resume Alice');
    const resumeResultB = await runResume(kernel2, v2Root);
    expect(resumeResultB).toBe('resume Bob');
    const resumeResultC = await runResume(kernel2, v3Root);
    expect(resumeResultC).toBe('resume Carol');
    await waitUntilQuiescent(1000);
    const vatLogs = extractTestLogs(
      [...entries1, ...entries2],
      'v1',
      'v2',
      'v3',
    );
    expect(sortLogs(vatLogs)).toStrictEqual(reference);
  });
});
