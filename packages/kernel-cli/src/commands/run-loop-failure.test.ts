// The mock shim rather than real lockdown: `vi.useFakeTimers()` cannot install
// its clock over a hardened `Date`, and this module's watchdog is the thing
// under test.
import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  cleanUpFailedStartup,
  logBestEffort,
  makeDaemonRunLoopWiring,
  makeRunLoopFailureHandler,
  SHUTDOWN_TIMEOUT_MS,
} from './run-loop-failure.ts';
import type {
  DaemonRunLoopWiring,
  DaemonRunLoopWiringOptions,
  FailedStartupCleanupOptions,
  RunLoopFailureHandlerOptions,
} from './run-loop-failure.ts';

/**
 * Make a handler over spies, defaulting to "the daemon is up and not shutting
 * down" so each test overrides only what it is about.
 *
 * @param overrides - Options to replace.
 * @returns The handler and the spies it was built from.
 */
const makeHandler = (
  overrides: Partial<RunLoopFailureHandlerOptions> = {},
): {
  handle: (failure: Error) => void;
  logger: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  shutdown: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
  removePidFile: ReturnType<typeof vi.fn>;
  setExitCode: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
} => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const recordFailure = vi.fn();
  const removePidFile = vi.fn();
  const setExitCode = vi.fn();
  const exit = vi.fn();
  const handle = makeRunLoopFailureHandler({
    logger,
    shutdown,
    isStarted: () => true,
    isShuttingDown: () => false,
    recordFailure,
    removePidFile,
    setExitCode,
    exit,
    ...overrides,
  });
  return {
    handle,
    logger,
    shutdown,
    recordFailure,
    removePidFile,
    setExitCode,
    exit,
  };
};

// `daemon-entry` calls this in front of every `process.exit` it owns, and that
// exit is the only thing that terminates live vat workers.
describe('logBestEffort', () => {
  it('records the message', () => {
    const logger = { error: vi.fn(), info: vi.fn() };

    logBestEffort(logger, 'error', 'Daemon fatal', 'the detail');

    expect(logger.error).toHaveBeenCalledWith('Daemon fatal', 'the detail');
  });

  it.each(['error', 'info'] as const)(
    'swallows a %s transport that throws',
    (level) => {
      const logger = {
        error: vi.fn().mockImplementation(() => {
          throw new Error('ENOSPC');
        }),
        info: vi.fn().mockImplementation(() => {
          throw new Error('ENOSPC');
        }),
      };

      expect(() => logBestEffort(logger, level, 'Daemon fatal')).not.toThrow();
    },
  );
});

describe('makeRunLoopFailureHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shuts the daemon down and marks the exit non-zero', async () => {
    const { handle, shutdown, setExitCode, logger, exit } = makeHandler();

    handle(new Error('crank exploded'));
    await vi.runAllTimersAsync();

    expect(shutdown).toHaveBeenCalledWith('run loop failure');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Kernel run loop died; shutting down the daemon.',
      expect.stringContaining('crank exploded'),
    );
    // A shutdown that worked leaves the process to wind down on its own.
    expect(exit).not.toHaveBeenCalled();
  });

  // `stringify` is what carries the chain; `error.stack` would drop it, and when
  // a crank's rollback fails the rollback is the outer error and the failure that
  // actually killed the kernel is only reachable through `cause`.
  it('logs the cause chain, not just the outermost error', () => {
    const { handle, logger } = makeHandler();

    handle(
      new Error('could not be rolled back', {
        cause: new Error('database is gone'),
      }),
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Kernel run loop died; shutting down the daemon.',
      expect.stringContaining('database is gone'),
    );
  });

  it('records the failure before doing anything else', () => {
    const failure = new Error('crank exploded');
    const { handle, recordFailure } = makeHandler({ isStarted: () => false });

    handle(failure);

    expect(recordFailure).toHaveBeenCalledWith(failure);
  });

  it('only records the first failure', () => {
    let recorded: Error | undefined;
    const { handle } = makeHandler({
      recordFailure: (failure) => {
        recorded ??= failure;
      },
      isStarted: () => false,
    });

    handle(new Error('first'));
    handle(new Error('second'));

    expect(recorded?.message).toBe('first');
  });

  it('does not shut down before the daemon has started', () => {
    const { handle, shutdown, setExitCode, logger } = makeHandler({
      isStarted: () => false,
    });

    handle(new Error('died during startup'));

    expect(shutdown).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Kernel run loop died before the daemon started.',
      expect.stringContaining('died during startup'),
    );
  });

  // A loop stopping because someone asked the daemon to stop is not an outage,
  // and must not turn a deliberate `ocap daemon stop` into a non-zero exit.
  it('does not fail a shutdown already under way', () => {
    const { handle, shutdown, setExitCode, exit, logger } = makeHandler({
      isShuttingDown: () => true,
    });

    handle(new Error('loop stopped'));

    expect(shutdown).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Kernel run loop stopped during shutdown.',
      expect.stringContaining('loop stopped'),
    );
  });

  // Live vat workers hold the event loop open, so `setExitCode` alone would leave
  // an orphan on kernel.sqlite with its socket already gone.
  it('kills the process when the shutdown stalls', async () => {
    const { handle, removePidFile, exit, logger } = makeHandler({
      shutdown: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    handle(new Error('crank exploded'));
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);

    expect(logger.error).toHaveBeenCalledWith(
      `Shutdown stalled for ${SHUTDOWN_TIMEOUT_MS} ms after run loop failure; exiting now.`,
    );
    // Removed before exiting, so the next `ocap daemon start` isn't blocked by a
    // pid file whose owner is gone.
    expect(removePidFile).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('waits the full timeout before killing the process', async () => {
    const { handle, exit } = makeHandler({
      shutdown: vi.fn().mockReturnValue(new Promise(() => undefined)),
      timeoutMs: 5_000,
    });

    handle(new Error('crank exploded'));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('kills the process when the shutdown throws', async () => {
    const { handle, removePidFile, exit, logger } = makeHandler({
      shutdown: vi.fn().mockRejectedValue(new Error('close failed')),
    });

    handle(new Error('crank exploded'));
    await vi.runAllTimersAsync();

    expect(logger.error).toHaveBeenCalledWith(
      'Shutdown after run loop failure failed; exiting now.',
      expect.stringContaining('close failed'),
    );
    expect(removePidFile).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  // The watchdog must not fire after the process is already on its way out, or a
  // second `exit` lands during teardown.
  it('disarms the watchdog once the shutdown settles', async () => {
    const { handle, exit } = makeHandler({
      shutdown: vi.fn().mockRejectedValue(new Error('close failed')),
    });

    handle(new Error('crank exploded'));
    await vi.runAllTimersAsync();
    expect(exit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS * 2);

    expect(exit).toHaveBeenCalledOnce();
  });

  it('still exits when removing the pid file fails', async () => {
    const { handle, exit, logger } = makeHandler({
      shutdown: vi.fn().mockRejectedValue(new Error('close failed')),
      removePidFile: () => {
        throw new Error('EPERM');
      },
    });

    handle(new Error('crank exploded'));
    await vi.runAllTimersAsync();

    expect(logger.error).toHaveBeenCalledWith(
      'Could not remove the pid file before exiting.',
      expect.stringContaining('EPERM'),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  // The daemon logs with `appendFileSync`, and the kernel swallows what this
  // handler throws, so a failed log would leave a daemon serving a dead kernel.
  it('shuts down even when the log transport throws', async () => {
    const { handle, shutdown, setExitCode, exit } = makeHandler({
      logger: {
        error: vi.fn().mockImplementation(() => {
          throw new Error('ENOSPC');
        }),
        info: vi.fn(),
      },
    });

    expect(() => handle(new Error('crank exploded'))).not.toThrow();
    await vi.runAllTimersAsync();

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(shutdown).toHaveBeenCalledWith('run loop failure');
    expect(exit).not.toHaveBeenCalled();
  });

  // The disk can fill up between the first log and the last.
  it('kills the process when a later log transport throws', async () => {
    let calls = 0;
    const { handle, removePidFile, exit } = makeHandler({
      logger: {
        error: vi.fn().mockImplementation(() => {
          calls += 1;
          if (calls > 1) {
            throw new Error('ENOSPC');
          }
        }),
        info: vi.fn(),
      },
      shutdown: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    handle(new Error('crank exploded'));
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);

    expect(removePidFile).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  // An unhandled rejection here would be reported as the cause of death instead
  // of the run loop failure that actually killed the kernel.
  it('does not reject when exiting throws', async () => {
    const onUnhandled = vi.fn();
    process.once('unhandledRejection', onUnhandled);

    const { handle } = makeHandler({
      shutdown: vi.fn().mockRejectedValue(new Error('close failed')),
      exit: vi.fn().mockImplementation(() => {
        throw new Error('exit refused');
      }),
    });

    handle(new Error('crank exploded'));
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(onUnhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', onUnhandled);
  });
});

/**
 * Make the cleanup's options over spies, defaulting to a kernel that stops
 * cleanly, so each test overrides only what it is about.
 *
 * @param overrides - Options to replace.
 * @returns The options, with their spies reachable.
 */
const makeCleanupOptions = (
  overrides: Partial<FailedStartupCleanupOptions> = {},
): FailedStartupCleanupOptions => ({
  logger: { error: vi.fn(), info: vi.fn() },
  stopKernel: vi.fn().mockResolvedValue(undefined),
  closeDatabase: vi.fn(),
  removePidFile: vi.fn(),
  ...overrides,
});

describe('cleanUpFailedStartup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // `stop` terminates the vat workers only after writing the last-active
  // timestamp, so a database closed first makes that write throw and the worker
  // threads that hold the event loop open survive.
  it('waits for the kernel to stop before closing the database', async () => {
    const order: string[] = [];
    const options = makeCleanupOptions({
      stopKernel: async () => {
        await Promise.resolve();
        order.push('stop');
      },
      closeDatabase: () => order.push('close'),
      removePidFile: () => order.push('removePid'),
    });

    await cleanUpFailedStartup(options);

    expect(order).toStrictEqual(['stop', 'close', 'removePid']);
  });

  it('gives up on a kernel that never stops', async () => {
    const options = makeCleanupOptions({
      stopKernel: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    const cleanup = cleanUpFailedStartup(options);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await cleanup;

    expect(options.logger.error).toHaveBeenCalledWith(
      `Kernel did not stop within ${SHUTDOWN_TIMEOUT_MS} ms during startup cleanup.`,
    );
    expect(options.closeDatabase).toHaveBeenCalled();
    expect(options.removePidFile).toHaveBeenCalled();
  });

  it('waits the full timeout before giving up on the kernel', async () => {
    const options = makeCleanupOptions({
      stopKernel: vi.fn().mockReturnValue(new Promise(() => undefined)),
      timeoutMs: 5_000,
    });

    const cleanup = cleanUpFailedStartup(options);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(options.closeDatabase).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await cleanup;

    expect(options.closeDatabase).toHaveBeenCalled();
  });

  it('closes the database when the kernel could not be stopped', async () => {
    const options = makeCleanupOptions({
      stopKernel: vi.fn().mockRejectedValue(new Error('crank never ended')),
    });

    await cleanUpFailedStartup(options);

    expect(options.logger.error).toHaveBeenCalledWith(
      'Could not stop the kernel during startup cleanup.',
      expect.stringContaining('crank never ended'),
    );
    expect(options.closeDatabase).toHaveBeenCalled();
    expect(options.removePidFile).toHaveBeenCalled();
  });

  // A `stop` that ran to completion closed the database itself, so the second
  // close throwing is the expected case and must not strand the pid file.
  it('removes the pid file when closing the database throws', async () => {
    const options = makeCleanupOptions({
      closeDatabase: () => {
        throw new Error('database is not open');
      },
    });

    await cleanUpFailedStartup(options);

    expect(options.removePidFile).toHaveBeenCalled();
  });

  it('logs a pid file that could not be removed', async () => {
    const options = makeCleanupOptions({
      removePidFile: () => {
        throw new Error('EPERM');
      },
    });

    // Rejecting here would take the startup error with it, replacing the reason
    // the daemon could not start with the reason its cleanup could not finish.
    await cleanUpFailedStartup(options);

    expect(options.logger.error).toHaveBeenCalledWith(
      'Could not remove the pid file during startup cleanup.',
      expect.stringContaining('EPERM'),
    );
  });

  // Only `cause` carries the reason the kernel would not stop.
  it('logs the cause chain of a stop that failed', async () => {
    const options = makeCleanupOptions({
      stopKernel: vi
        .fn()
        .mockRejectedValue(
          new Error('could not stop', { cause: new Error('database is gone') }),
        ),
    });

    await cleanUpFailedStartup(options);

    expect(options.logger.error).toHaveBeenCalledWith(
      'Could not stop the kernel during startup cleanup.',
      expect.stringContaining('database is gone'),
    );
  });

  // The daemon logs with `appendFileSync`, so a full disk throws, and cleanup is
  // the last thing standing between a failed startup and an orphan.
  it('cleans up even when the log transport throws', async () => {
    const options = makeCleanupOptions({
      logger: {
        error: vi.fn().mockImplementation(() => {
          throw new Error('ENOSPC');
        }),
        info: vi.fn(),
      },
      stopKernel: vi.fn().mockRejectedValue(new Error('crank never ended')),
    });

    await cleanUpFailedStartup(options);

    expect(options.closeDatabase).toHaveBeenCalled();
    expect(options.removePidFile).toHaveBeenCalled();
  });
});

/**
 * Make the daemon wiring over spies.
 *
 * @param overrides - Options to replace.
 * @returns The wiring and the spies it was built from.
 */
const makeWiring = (
  overrides: Partial<DaemonRunLoopWiringOptions> = {},
): {
  wiring: DaemonRunLoopWiring;
  shutdown: ReturnType<typeof vi.fn>;
  setExitCode: ReturnType<typeof vi.fn>;
} => {
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const setExitCode = vi.fn();
  const wiring = makeDaemonRunLoopWiring({
    logger: { error: vi.fn(), info: vi.fn() },
    shutdown,
    isShuttingDown: () => false,
    removePidFile: vi.fn(),
    setExitCode,
    exit: vi.fn(),
    ...overrides,
  });
  return { wiring, shutdown, setExitCode };
};

describe('makeDaemonRunLoopWiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shuts the daemon down when the run loop dies after startup', async () => {
    const { wiring, shutdown } = makeWiring();
    wiring.daemonStarted();

    wiring.onRunLoopFailure(new Error('crank exploded'));
    await vi.runAllTimersAsync();

    expect(shutdown).toHaveBeenCalledWith('run loop failure');
  });

  // The kernel can report a death before `startDaemon` has returned.
  it('holds a failure that arrives before the daemon has started', () => {
    const { wiring, shutdown, setExitCode } = makeWiring();

    wiring.onRunLoopFailure(new Error('died during startup'));

    expect(shutdown).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('unwinds startup when the run loop died on the way up', () => {
    const { wiring } = makeWiring();
    const failure = new Error('died during startup');

    wiring.onRunLoopFailure(failure);

    // Only `cause` carries the reason it died.
    expect(() => wiring.assertSurvivedStartup()).toThrow(
      expect.objectContaining({
        message: 'Kernel run loop died during startup',
        cause: failure,
      }),
    );
  });

  it('lets startup proceed while the run loop is alive', () => {
    const { wiring } = makeWiring();

    expect(() => wiring.assertSurvivedStartup()).not.toThrow();
  });

  // A loop that died between startup's check and the daemon coming up would
  // otherwise leave it serving RPCs for a dead kernel forever.
  it('replays a held failure once there is a daemon to close', async () => {
    const { wiring, shutdown, setExitCode } = makeWiring();
    wiring.onRunLoopFailure(new Error('died during startup'));

    wiring.daemonStarted();
    await vi.runAllTimersAsync();

    expect(shutdown).toHaveBeenCalledWith('run loop failure');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('does not shut down a daemon whose run loop is alive', async () => {
    const { wiring, shutdown } = makeWiring();

    wiring.daemonStarted();
    await vi.runAllTimersAsync();

    expect(shutdown).not.toHaveBeenCalled();
  });

  // Whatever the loop reports afterwards is fallout from the first failure.
  it('replays the first failure when several arrive before the daemon starts', async () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const { wiring } = makeWiring({ logger });
    wiring.onRunLoopFailure(new Error('first'));
    wiring.onRunLoopFailure(new Error('second'));

    wiring.daemonStarted();
    await vi.runAllTimersAsync();

    expect(logger.error).toHaveBeenCalledWith(
      'Kernel run loop died; shutting down the daemon.',
      expect.stringContaining('first'),
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      'Kernel run loop died; shutting down the daemon.',
      expect.stringContaining('second'),
    );
  });
});
