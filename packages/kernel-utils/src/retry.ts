import { AbortError } from '@metamask/kernel-errors';

import { abortableDelay } from './misc.ts';

/** The default maximum number of retry attempts. */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 0; // 0 = infinite
/** The default base delay in milliseconds. */
export const DEFAULT_BASE_DELAY_MS = 500;
/** The default maximum delay in milliseconds. */
export const DEFAULT_MAX_DELAY_MS = 10_000;

export type RetryBackoffOptions = Readonly<{
  /** 0 means infinite attempts */
  maxAttempts?: number;
  /** The base delay in milliseconds. */
  baseDelayMs?: number;
  /** The maximum delay in milliseconds. */
  maxDelayMs?: number;
  /** Whether to use full jitter. */
  jitter?: boolean;
  /** A function to determine if an error is retryable. */
  shouldRetry?: (error: unknown) => boolean;
  /** A function to observe each retry schedule. */
  onRetry?: (info: Readonly<RetryOnRetryInfo>) => void;
  /** An abort signal to cancel the whole retry operation. */
  signal?: AbortSignal;
}>;

export type RetryOnRetryInfo = {
  /** The 1-based attempt that just failed. */
  attempt: number;
  /** The resolved numeric maximum number of attempts. */
  maxAttempts: number;
  /** The delay in milliseconds. */
  delayMs: number;
  /** The error that occurred. */
  error: unknown;
};

/**
 * Calculate exponential backoff with optional full jitter.
 * attempt is 1-based.
 *
 * @param attempt - The 1-based attempt that just failed.
 * @param opts - The options for the backoff.
 * @returns The delay in milliseconds.
 */
export function calculateReconnectionBackoff(
  attempt: number,
  opts?: Pick<RetryBackoffOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter'>,
): number {
  const base = Math.max(1, opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const cap = Math.max(base, opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const pow = Math.max(0, attempt - 1);
  const raw = Math.min(cap, base * Math.pow(2, pow));
  const useJitter = opts?.jitter !== false;
  if (useJitter) {
    // Full jitter in [0, raw)
    return Math.floor(Math.random() * raw);
  }
  return raw;
}

/**
 * Generic retry helper with backoff.
 * Throws the last error if attempts exhausted or shouldRetry returns false.
 *
 * @param operation - The operation to retry.
 * @param options - The options for the retry.
 * @returns The result of the operation.
 * @throws If the operation fails and shouldRetry returns false or if the maximum number of attempts is reached.
 */
export async function retry<Result>(
  operation: () => Promise<Result>,
  options?: RetryBackoffOptions,
): Promise<Result> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const shouldRetry = options?.shouldRetry ?? (() => true);

  let attempt = 0;
  const isInfinite = maxAttempts === 0;
  // Loop until success or we hit a finite cap. 0 = infinite attempts.
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (isInfinite || attempt < maxAttempts) {
    if (options?.signal?.aborted) {
      throw new AbortError();
    }

    try {
      attempt += 1;
      return await operation();
    } catch (error) {
      const canRetry = shouldRetry(error);
      const finalAttempt = !isInfinite && attempt >= maxAttempts;
      if (!canRetry || finalAttempt) {
        throw error;
      }

      const delayMs = calculateReconnectionBackoff(attempt, {
        baseDelayMs: options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
        maxDelayMs: options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
        jitter: options?.jitter ?? true,
      });

      options?.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error,
      });

      await abortableDelay(delayMs, options?.signal);
      // Continue loop
    }
    /* v8 ignore start */
  }

  // Unreachable (loop returns or throws)
  throw new Error('Retry operation ended unexpectedly');
}
/* v8 ignore stop */

/**
 * Compatibility wrapper for existing call sites
 *
 * @param operation - The operation to retry.
 * @param options - The options for the retry.
 * @returns The result of the operation.
 * @throws If the operation fails and shouldRetry returns false or if the maximum number of attempts is reached.
 */
export async function retryWithBackoff<Result>(
  operation: () => Promise<Result>,
  options?: RetryBackoffOptions,
): Promise<Result> {
  return retry(operation, options);
}
