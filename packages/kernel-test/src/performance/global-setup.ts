import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

import { RUNS_DIR, renderReport } from './report.ts';

/**
 * Give the run a directory of its own for the profiles' reports, and chart
 * them once every profile has finished, failed ones included.
 *
 * @param project - The test project.
 * @returns The teardown.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const runDir = path.join(
    RUNS_DIR,
    new Date().toISOString().replaceAll(':', '-'),
  );
  await mkdir(runDir, { recursive: true });
  project.provide('performanceRunDir', runDir);
  return async () => {
    const reportPath = await renderReport(runDir);
    if (reportPath) {
      process.stdout.write(`[performance] ${reportPath}\n`);
    }
  };
}
