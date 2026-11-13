import { describe, expect, it } from 'vitest';

import { browserFsOptions } from './browser.ts';
import { makeFsBase } from './shared.ts';

describe('fs browser capability', () => {
  // The configured capability narrows this base, and `narrow` forwards over
  // `E()`, which cannot run under `mock-endoify` — see `shared.test.ts`.
  const makeCapability = () =>
    makeFsBase(browserFsOptions) as unknown as Record<string, CallableFunction>;

  it.each([{ name: 'readFile' }, { name: 'access' }])(
    'rejects $name as not implemented',
    async ({ name }) => {
      await expect(makeCapability()[name]?.(['root', 'x'])).rejects.toThrow(
        `Capability ${name} is not implemented in the browser`,
      );
    },
  );
});
