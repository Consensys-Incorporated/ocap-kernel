import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { LogEntry } from '@metamask/logger';
import type { Kernel } from '@metamask/ocap-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  extractTestLogs,
  getBundleSpec,
  makeKernel,
  makeTestLogger,
} from './utils.ts';

// No per-suite timeout override: the package's 30s default covers the kernel
// construction each test does in `beforeEach`, which is slow enough on a
// loaded CI runner to blow a tighter budget.
describe('cluster initialization', () => {
  let logger: Logger;
  let entries: LogEntry[];
  let kernel: Kernel;

  type When = 'global' | 'build' | 'bootstrap';
  type What = 'throw' | 'uncaught-rejection';

  beforeEach(async () => {
    const testLogger = makeTestLogger();
    logger = testLogger.logger;
    entries = testLogger.entries;
    const database = await makeSQLKernelDatabase({});
    kernel = await makeKernel(
      database,
      true,
      logger.subLogger({ tags: ['test'] }),
    );
  });

  const launch = async (scenario: `${When}-${What}`) =>
    kernel.launchSubcluster({
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec(`error-${scenario}`),
          parameters: {},
        },
      },
    });

  it('throws if globals scope throws', async () => {
    await expect(launch('global-throw')).rejects.toMatchObject({
      message: expect.stringMatching(/^Failed to launch vat \S+ \(main\)$/u),
      cause: { message: expect.stringMatching(/from global scope/u) },
    });

    const vatLogs = extractTestLogs(entries, 'console');
    expect(vatLogs).toStrictEqual(['global throw']);
  });

  it.todo('throws if global scope has an uncaught rejection', async () => {
    await expect(launch('global-uncaught-rejection')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Subcluster initialization failed'),
        cause: expect.stringMatching(
          /[Uu]nknown(.)+uncaught promise rejection/u,
        ),
      }),
    );

    const vatLogs = extractTestLogs(entries, 'console');
    expect(vatLogs).toStrictEqual(['global uncaught rejection']);
  });

  it('throws if buildRootObject throws', async () => {
    await expect(launch('build-throw')).rejects.toMatchObject({
      message: expect.stringMatching(/^Failed to launch vat \S+ \(main\)$/u),
      cause: { message: expect.stringMatching(/from buildRootObject/u) },
    });

    const vatLogs = extractTestLogs(entries, 'console');
    expect(vatLogs).toStrictEqual(['build throw', 'buildRootObject']);
  });

  it.todo('throws if buildRootObject has an uncaught rejection', async () => {
    await expect(launch('build-uncaught-rejection')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Subcluster initialization failed'),
        cause: expect.stringMatching(
          /[Uu]nknown(.)+uncaught promise rejection/u,
        ),
      }),
    );

    const vatLogs = extractTestLogs(entries, 'console');
    expect(vatLogs).toStrictEqual([
      'build uncaught rejection',
      'buildRootObject',
      'bootstrap',
    ]);
  });

  it('throws if bootstrap throws', async () => {
    await expect(launch('bootstrap-throw')).rejects.toThrow(/from bootstrap/u);

    const vatLogs = extractTestLogs(entries, 'console');
    expect(vatLogs).toStrictEqual([
      'bootstrap throw',
      'buildRootObject',
      'bootstrap',
    ]);
  });

  it.todo('throws if bootstrap has an uncaught rejection', async () => {
    await expect(launch('bootstrap-uncaught-rejection')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Subcluster initialization failed'),
        cause: expect.stringMatching(
          /[Uu]nknown(.)+uncaught promise rejection/u,
        ),
      }),
    );

    const vatLogs = extractTestLogs(entries, 'console');
    expect(vatLogs).toStrictEqual([
      'bootstrap uncaught rejection',
      'buildRootObject',
      'bootstrap',
    ]);
  });
});

describe('a launch whose peer vat fails', () => {
  let logger: Logger;
  let entries: LogEntry[];
  let kernel: Kernel;

  beforeEach(async () => {
    const testLogger = makeTestLogger();
    logger = testLogger.logger;
    entries = testLogger.entries;
    const database = await makeSQLKernelDatabase({});
    kernel = await makeKernel(
      database,
      true,
      logger.subLogger({ tags: ['test'] }),
    );
  });

  it('rolls the launch back whole, before bootstrap, when a peer vat fails to launch', async () => {
    await expect(
      kernel.launchSubcluster({
        bootstrap: 'main',
        vats: {
          main: {
            bundleSpec: getBundleSpec('peer-rejection-bootstrap'),
            parameters: {},
          },
          peer: {
            bundleSpec: getBundleSpec('error-build-throw'),
            parameters: {},
          },
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^Failed to launch vat \S+ \(peer\)$/u),
    });
    await waitUntilQuiescent(200);

    const vatLogs = extractTestLogs(entries, 'console');
    expect({
      bootstrapped: vatLogs.filter((log) => log.startsWith('peer rejected:')),
      vats: kernel.getVatIds(),
      subclusters: kernel.getSubclusters(),
    }).toStrictEqual({ bootstrapped: [], vats: [], subclusters: [] });
  });
});
