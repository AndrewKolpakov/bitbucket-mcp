import type { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import type winston from "winston";

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 20_000;

/** Transient statuses worth a second attempt. 429 is the common one: */
/** following `next` links can fire ten requests back to back. */
export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Only idempotent verbs are retried. Replaying a POST could create a second
 * comment or approval, which is worse than surfacing the error.
 */
export const RETRYABLE_METHODS = new Set(["get", "head"]);

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  random?: () => number;
  /** Injectable for tests (used to interpret HTTP-date Retry-After). */
  now?: () => number;
}

interface RetryableConfig extends AxiosRequestConfig {
  __retryCount?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Parse `Retry-After`, which is either a delay in seconds or an HTTP date.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(
  header: unknown,
  now: () => number = Date.now
): number | undefined {
  if (header === undefined || header === null) return undefined;
  const raw = String(header).trim();
  if (raw === "") return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * 1000 : 0;
  }

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now());
}

/**
 * Delay before attempt `attempt` (1-based): the server's `Retry-After` when it
 * sent one, otherwise capped exponential backoff with jitter.
 */
export function computeRetryDelayMs(
  attempt: number,
  retryAfterHeader: unknown,
  options: RetryOptions = {}
): number {
  const {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    random = Math.random,
    now = Date.now,
  } = options;

  const retryAfter = parseRetryAfterMs(retryAfterHeader, now);
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, maxDelayMs);
  }

  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = exponential * 0.2 * random();
  return Math.min(Math.round(exponential + jitter), maxDelayMs);
}

export function isRetryable(error: AxiosError): boolean {
  const status = error.response?.status;
  const method = error.config?.method?.toLowerCase();
  if (status === undefined || method === undefined) return false;
  return RETRYABLE_STATUSES.has(status) && RETRYABLE_METHODS.has(method);
}

/**
 * Retry transient failures on read requests.
 *
 * Without this a single 429 in the middle of an `all: true` walk threw away
 * every page already collected.
 */
export function attachRetryInterceptor(
  api: AxiosInstance,
  logger: Pick<winston.Logger, "warn">,
  options: RetryOptions = {}
): void {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    sleep = defaultSleep,
  } = options;

  api.interceptors.response.use(undefined, async (error: AxiosError) => {
    if (maxRetries < 1 || !isRetryable(error)) {
      throw error;
    }

    const config = error.config as RetryableConfig;
    const attempt = (config.__retryCount ?? 0) + 1;
    if (attempt > maxRetries) {
      throw error;
    }
    config.__retryCount = attempt;

    const delayMs = computeRetryDelayMs(
      attempt,
      error.response?.headers?.["retry-after"],
      options
    );

    logger.warn("Retrying Bitbucket request after transient failure", {
      url: config.url,
      status: error.response?.status,
      attempt,
      maxRetries,
      delayMs,
    });

    await sleep(delayMs);
    return api.request(config);
  });
}
