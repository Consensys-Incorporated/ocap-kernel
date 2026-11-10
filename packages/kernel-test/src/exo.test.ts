import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { LogEntry } from '@metamask/logger';
import { Kernel, kunser } from '@metamask/ocap-kernel';
import type { KRef } from '@metamask/ocap-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  extractTestLogs,
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runTestVats,
} from './utils.ts';

const testSubcluster = {
  bootstrap: 'exoTest',
  forceReset: true,
  vats: {
    exoTest: {
      bundleSpec: getBundleSpec('exo-vat'),
      parameters: {
        name: 'ExoTest',
      },
    },
  },
};

// First vat root object is ko4 due to the kernel facet and other kernel service objects being created before any vats.
const exoTestRoot = 'ko4' as KRef;

describe('virtual objects functionality', async () => {
  let kernel: Kernel;
  let logEntries: LogEntry[];
  let bootstrapResult: unknown;

  /**
   * Clears the log entries array.
   * Used to ignore logs from before a given test checkpoint.
   */
  const clearLogEntries = () => {
    logEntries.length = 0;
  };

  beforeEach(async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { logger, entries } = makeTestLogger();
    kernel = await makeKernel(kernelDatabase, true, logger);
    bootstrapResult = await runTestVats(kernel, testSubcluster);
    logEntries = entries;
    await waitUntilQuiescent(100);
  });

  it('successfully creates and uses exo objects and scalar stores', async () => {
    expect(bootstrapResult).toBe('exo-test-complete');
    const vatLogs = extractTestLogs(logEntries, 'ExoTest');
    expect(vatLogs).toStrictEqual([
      'initializing state',
      'counter value from baggage: 0',
      'bootstrap()',
      'Created counter with initial value: 10',
      'Incremented counter by 5 to: 15',
      'ERROR: Increment with negative value should have failed',
      'Alice has 1 friends',
      'Added 2 entries to map store',
      'Added 2 entries to set store',
      'Retrieved Alice from map store',
      'Temperature at 25°C = 77°F',
      'After setting to 68°F, celsius is 20°C',
      'SimpleCounter initial value: 0',
      'SimpleCounter after +7: 7',
      'Updated baggage counter to: 7',
    ]);
  });

  it('tests scalar store functionality', async () => {
    expect(bootstrapResult).toBe('exo-test-complete');
    clearLogEntries();
    const storeResult = await kernel.queueMessage(
      exoTestRoot,
      'testScalarStore',
      [],
    );
    await waitUntilQuiescent(100);
    expect(kunser(storeResult)).toBe('scalar-store-tests-complete');
    const vatLogs = extractTestLogs(logEntries, 'ExoTest');
    expect(vatLogs).toStrictEqual([
      'Map store size: 3',
      'Map store keys: alice, bob, charlie',
      "Map has 'charlie': true",
      'Set store size: 3',
      'Set has Charlie: true',
    ]);
  });

  it('can create and use objects through messaging', async () => {
    expect(bootstrapResult).toBe('exo-test-complete');
    clearLogEntries();
    const counterResult = await kernel.queueMessage(
      exoTestRoot,
      'createCounter',
      [42],
    );
    await waitUntilQuiescent();
    const counterRef = counterResult.slots[0] as KRef;
    const incrementResult = await kernel.queueMessage(
      counterRef,
      'increment',
      [5],
    );
    // Verify the increment result
    expect(kunser(incrementResult)).toBe(47);
    await waitUntilQuiescent();
    const personResult = await kernel.queueMessage(
      exoTestRoot,
      'createPerson',
      ['Dave', 35],
    );
    await waitUntilQuiescent();
    const personRef = personResult.slots[0] as KRef;
    await kernel.queueMessage(exoTestRoot, 'createOrUpdateInMap', [
      'dave',
      personRef,
    ]);
    await waitUntilQuiescent();

    // Get object from map store
    const retrievedPerson = await kernel.queueMessage(
      exoTestRoot,
      'getFromMap',
      ['dave'],
    );
    await waitUntilQuiescent();
    // Verify the retrieved person object
    expect(kunser(retrievedPerson)).toBe(personRef);
    await kernel.queueMessage(exoTestRoot, 'createOrUpdateInMap', [
      'dave',
      personRef,
    ]);
    await waitUntilQuiescent(100);
    const vatLogs = extractTestLogs(logEntries, 'ExoTest');
    // Verify counter was created and used
    expect(vatLogs).toStrictEqual([
      'Created new counter with value: 42',
      'Created person Dave, age 35',
      'Added dave to map, size now: 3',
      'Found dave in map',
      'Updated dave in map',
    ]);
  });

  it('tests exoClass type validation and behavior', async () => {
    expect(bootstrapResult).toBe('exo-test-complete');
    clearLogEntries();
    const exoClassResult = await kernel.queueMessage(
      exoTestRoot,
      'testExoClass',
      [],
    );
    await waitUntilQuiescent(100);
    expect(kunser(exoClassResult)).toBe('exoClass-tests-complete');
    const vatLogs = extractTestLogs(logEntries, 'ExoTest');
    expect(vatLogs).toStrictEqual([
      'Counter: 3 + 5 = 8',
      'Counter: 8 - 2 = 6',
      'Successfully caught type error: In "increment" method of (Counter): arg 0: string "foo" - Must be a number',
    ]);
  });

  it('tests exoClassKit with multiple facets', async () => {
    expect(bootstrapResult).toBe('exo-test-complete');
    clearLogEntries();
    const exoClassKitResult = await kernel.queueMessage(
      exoTestRoot,
      'testExoClassKit',
      [],
    );
    await waitUntilQuiescent(100);
    expect(kunser(exoClassKitResult)).toBe('exoClassKit-tests-complete');
    const vatLogs = extractTestLogs(logEntries, 'ExoTest');
    expect(vatLogs).toStrictEqual([
      '20°C = 68°F',
      '32°F = 0°C',
      'Successfully caught cross-facet error: celsius.getFahrenheit is not a function',
    ]);
  });

  it('tests temperature converter through messaging', async () => {
    expect(bootstrapResult).toBe('exo-test-complete');
    clearLogEntries();
    // Create a temperature converter starting at 100°C
    const tempResult = await kernel.queueMessage(
      exoTestRoot,
      'createTemperature',
      [100],
    );
    await waitUntilQuiescent();
    // Get both facets from the result
    const tempKit = tempResult;
    const celsiusRef = tempKit.slots[0] as KRef;
    const fahrenheitRef = tempKit.slots[1] as KRef;
    // Get the celsius value
    const celsiusResult = await kernel.queueMessage(
      celsiusRef,
      'getCelsius',
      [],
    );
    expect(kunser(celsiusResult)).toBe(100);
    // Get the fahrenheit value
    const fahrenheitResult = await kernel.queueMessage(
      fahrenheitRef,
      'getFahrenheit',
      [],
    );
    expect(kunser(fahrenheitResult)).toBe(212);
    // Change the temperature using the fahrenheit facet
    const setFahrenheitResult = await kernel.queueMessage(
      fahrenheitRef,
      'setFahrenheit',
      [32],
    );
    expect(kunser(setFahrenheitResult)).toBe(32);
    // Verify that the celsius value changed
    const newCelsiusResult = await kernel.queueMessage(
      celsiusRef,
      'getCelsius',
      [],
    );
    expect(kunser(newCelsiusResult)).toBe(0);
    await waitUntilQuiescent(100);
    const vatLogs = extractTestLogs(logEntries, 'ExoTest');
    expect(vatLogs).toContain(
      'Created temperature converter starting at 100°C',
    );
  });
});
