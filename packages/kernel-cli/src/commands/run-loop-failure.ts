import { stringify } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';

/** How long a post-failure shutdown may take before the process is killed. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The subset of `Logger` this handler needs. */
type FailureLogger = Pick<Logger, 'error' | 'info'>;

/**
 * Log without letting the transport's own failure escape.
 *
 * The daemon's transport is `appendFileSync`, so a full disk throws. Every
 * caller is on a path where that throw would cost more than the lost line: the
 * kernel swallows what the failure handler throws, so a daemon serving a dead
 * kernel would stay up, and in the fatal handlers the log sits in front of the
 * `process.exit` that is the only thing terminating live vat workers.
 *
 * @param logger - Where to record the message.
 * @param level - The severity to record it at.
 * @param message - The message.
 * @param data - Additional detail, already stringified.
 */
export function logBestEffort(
  logger: FailureLogger,
  level: 'error' | 'info',
  message: string,
  ...data: string[]
): void {
  try {
    logger[level](message, ...data);
  } catch {
    // No transport left to report the transport with.
  }
}

export type RunLoopFailureHandlerOptions = {
  logger: FailureLogger;
  /** Shut the daemon down. Idempotent; concurrent calls coalesce. */
  shutdown: (reason: string) => Promise<void>;
  /** Whether there is a daemon to shut down yet. */
  isStarted: () => boolean;
  /** Whether a shutdown is already under way. */
  isShuttingDown: () => boolean;
  /** Record the failure so startup can consult it. */
  recordFailure: (failure: Error) => void;
  /** Remove the pid file. Must complete before the process exits. */
  removePidFile: () => void;
  setExitCode: (code: number) => void;
  exit: (code: number) => void;
  timeoutMs?: number;
};

/**
 * Build the daemon's run loop failure handler.
 *
 * Left alone, a dead run loop leaves the daemon answering RPCs for a kernel that
 * processes nothing — an outage only a client that reads `runLoop` in
 * `getStatus` can spot. Terminate instead, non-zero, so the failure is visible
 * and `ocap daemon start` can recover.
 *
 * Extracted from `daemon-entry` because that module shuts the process down as a
 * side effect of being imported, which leaves this logic untestable in place.
 *
 * @param options - Options bag.
 * @param options.logger - Where to record the failure.
 * @param options.shutdown - Shut the daemon down. Idempotent; calls coalesce.
 * @param options.isStarted - Whether there is a daemon to shut down yet.
 * @param options.isShuttingDown - Whether a shutdown is already under way.
 * @param options.recordFailure - Record the failure so startup can consult it.
 * @param options.removePidFile - Remove the pid file, synchronously.
 * @param options.setExitCode - Set the code the process will exit with.
 * @param options.exit - Terminate the process now.
 * @param options.timeoutMs - How long the shutdown may take before the process
 * is killed. Defaults to {@link SHUTDOWN_TIMEOUT_MS}.
 * @returns A handler suitable for `makeKernel`'s `onRunLoopFailure`.
 */
export function makeRunLoopFailureHandler({
  logger,
  shutdown,
  isStarted,
  isShuttingDown,
  recordFailure,
  removePidFile,
  setExitCode,
  exit,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}: RunLoopFailureHandlerOptions): (failure: Error) => void {
  return (failure: Error): void => {
    recordFailure(failure);

    if (!isStarted()) {
      // No daemon to close yet. Startup either unwinds at its own check or
      // replays this failure once there is something to shut down.
      logBestEffort(
        logger,
        'error',
        'Kernel run loop died before the daemon started.',
        stringify(failure, 0),
      );
      return;
    }

    if (isShuttingDown()) {
      // Expected teardown, not an outage: don't fail a deliberate stop.
      logBestEffort(
        logger,
        'info',
        'Kernel run loop stopped during shutdown.',
        stringify(failure, 0),
      );
      return;
    }

    setExitCode(1);

    // `stringify` rather than `failure.stack`, which omits the cause chain. When
    // a crank dies and its rollback then fails, the rollback failure is the
    // outermost message and the error that actually killed the kernel is only
    // reachable through `cause`.
    logBestEffort(
      logger,
      'error',
      'Kernel run loop died; shutting down the daemon.',
      stringify(failure, 0),
    );

    // A shutdown that throws would leave the socket gone and the pid file
    // removed by `shutdown`'s own cleanup, while live vat workers keep the event
    // loop alive — an orphan holding kernel.sqlite that neither interlock can
    // see, so the next `ocap daemon start` succeeds and two kernels contend for
    // the database. A shutdown that *hangs* never reaches that cleanup, so the
    // pid file survives and the pid interlock does still see the orphan — but it
    // is an orphan either way. Terminate in both cases. `setExitCode` is not
    // enough precisely because those worker handles keep the process running.
    const exitNow = (): void => {
      try {
        removePidFile();
      } catch (rmError) {
        logBestEffort(
          logger,
          'error',
          'Could not remove the pid file before exiting.',
          stringify(rmError, 0),
        );
      }
      exit(1);
    };

    const killTimer = setTimeout(() => {
      logBestEffort(
        logger,
        'error',
        `Shutdown stalled for ${timeoutMs} ms after run loop failure; exiting now.`,
      );
      exitNow();
    }, timeoutMs);

    shutdown('run loop failure')
      .then(
        () => clearTimeout(killTimer),
        (shutdownError: unknown) => {
          clearTimeout(killTimer);
          logBestEffort(
            logger,
            'error',
            'Shutdown after run loop failure failed; exiting now.',
            stringify(shutdownError, 0),
          );
          exitNow();
        },
      )
      // Reached only if a handler above throws, and an unhandled rejection here
      // would be reported as the cause of death instead of the run loop.
      .catch(() => undefined);
  };
}

export type FailedStartupCleanupOptions = {
  logger: FailureLogger;
  /** Stop the kernel, terminating the vat workers it launched. */
  stopKernel: () => Promise<void>;
  /** Close the kernel database. */
  closeDatabase: () => void;
  /** Remove the pid file. Must complete before the process exits. */
  removePidFile: () => void;
  /** How long the kernel may take to stop. Defaults to {@link SHUTDOWN_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/**
 * Tear down a kernel that startup could not finish bringing up.
 *
 * `Kernel.make` launches a worker thread per persisted vat before the run loop
 * starts, so by the time startup can fail there are usually live workers, and a
 * worker thread keeps the parent's event loop running. Nothing here can be
 * fired and forgotten: `stop` is what terminates those workers, and it only
 * reaches them after writing the last-active timestamp, so closing the database
 * first makes that write throw and the workers survive. The caller is expected
 * to terminate the process afterwards.
 *
 * @param options - Options bag.
 * @param options.logger - Where to record what could not be cleaned up.
 * @param options.stopKernel - Stop the kernel, terminating its vat workers.
 * @param options.closeDatabase - Close the kernel database.
 * @param options.removePidFile - Remove the pid file, synchronously.
 * @param options.timeoutMs - How long the kernel may take to stop.
 */
export async function cleanUpFailedStartup({
  logger,
  stopKernel,
  closeDatabase,
  removePidFile,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}: FailedStartupCleanupOptions): Promise<void> {
  // Bounded: `stop` waits for the current crank first, and a run loop that died
  // mid-crank may never end it.
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopKernel(),
      new Promise<void>((resolve) => {
        giveUpTimer = setTimeout(() => {
          logBestEffort(
            logger,
            'error',
            `Kernel did not stop within ${timeoutMs} ms during startup cleanup.`,
          );
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (stopError) {
    logBestEffort(
      logger,
      'error',
      'Could not stop the kernel during startup cleanup.',
      stringify(stopError, 0),
    );
  } finally {
    clearTimeout(giveUpTimer);
  }

  try {
    closeDatabase();
  } catch {
    // A `stop` that ran to completion closed the database itself, which is the
    // expected case rather than a fault. Nothing to salvage either way: the
    // process exits next, which releases the file lock regardless.
  }

  try {
    removePidFile();
  } catch (rmError) {
    logBestEffort(
      logger,
      'error',
      'Could not remove the pid file during startup cleanup.',
      stringify(rmError, 0),
    );
  }
}

export type DaemonRunLoopWiringOptions = {
  logger: FailureLogger;
  /** Shut the daemon down. Idempotent; concurrent calls coalesce. */
  shutdown: (reason: string) => Promise<void>;
  isShuttingDown: () => boolean;
  /** Remove the pid file. Must complete before the process exits. */
  removePidFile: () => void;
  setExitCode: (code: number) => void;
  exit: (code: number) => void;
  timeoutMs?: number;
};

export type DaemonRunLoopWiring = {
  /** Pass to `makeKernel` as `onRunLoopFailure`. */
  onRunLoopFailure: (failure: Error) => void;
  /** @throws If the run loop has already died, to unwind startup. */
  assertSurvivedStartup: () => void;
  /** Replays a failure that arrived before there was a daemon to shut down. */
  daemonStarted: () => void;
};

/**
 * Wire the run loop failure handler to the daemon's lifecycle.
 *
 * A failure can land before there is a daemon to shut down, so it is held for
 * startup's own check and replayed once there is one. Extracted from
 * `daemon-entry` because that module shuts the process down as a side effect of
 * being imported, which leaves this untestable in place.
 *
 * @param options - Options bag, forwarded to {@link makeRunLoopFailureHandler}
 * apart from the lifecycle state this owns.
 * @param options.logger - Where to record the failure.
 * @param options.shutdown - Shut the daemon down. Idempotent; calls coalesce.
 * @param options.isShuttingDown - Whether a shutdown is already under way.
 * @param options.removePidFile - Remove the pid file, synchronously.
 * @param options.setExitCode - Set the code the process will exit with.
 * @param options.exit - Terminate the process now.
 * @param options.timeoutMs - How long the shutdown may take before the process
 * is killed.
 * @returns The wiring `daemon-entry` hangs off the kernel and its own startup.
 */
export function makeDaemonRunLoopWiring({
  logger,
  shutdown,
  isShuttingDown,
  removePidFile,
  setExitCode,
  exit,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}: DaemonRunLoopWiringOptions): DaemonRunLoopWiring {
  let failure: Error | undefined;
  let started = false;

  const onRunLoopFailure = makeRunLoopFailureHandler({
    logger,
    shutdown,
    isStarted: () => started,
    isShuttingDown,
    // Whatever the loop reports next is fallout, including the replay below.
    recordFailure: (first) => {
      failure ??= first;
    },
    removePidFile,
    setExitCode,
    exit,
    timeoutMs,
  });

  return harden({
    onRunLoopFailure,
    assertSurvivedStartup: () => {
      if (failure) {
        throw new Error('Kernel run loop died during startup', {
          cause: failure,
        });
      }
    },
    daemonStarted: () => {
      started = true;
      if (failure) {
        onRunLoopFailure(failure);
      }
    },
  });
}
