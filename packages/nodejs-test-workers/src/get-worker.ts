/* oxlint-disable node/no-sync */
import { existsSync } from 'node:fs';

export const getWorkerFile = (name: string): string => {
  const filePath = new URL(`../dist/workers/${name}.js`, import.meta.url)
    .pathname;
  // Check that the file exists
  if (!existsSync(filePath)) {
    throw new Error(`Worker file ${name} not found`);
  }
  return filePath;
};
