import { jest } from "@jest/globals";
import type { AxiosError, AxiosInstance } from "axios";
import {
  attachRetryInterceptor,
  computeRetryDelayMs,
  isRetryable,
  parseRetryAfterMs,
} from "../src/retry.js";

const createMockApi = () => {
  let rejected: ((error: AxiosError) => Promise<any>) | undefined;
  const api = {
    interceptors: {
      response: {
        use: (_fulfilled: unknown, onRejected: any) => {
          rejected = onRejected;
        },
      },
    },
    request: jest.fn(async () => ({ data: { ok: true } })),
  };
  return {
    api: api as unknown as AxiosInstance & { request: jest.Mock },
    handler: () => rejected!,
  };
};

const createLogger = () => ({ warn: jest.fn() }) as any;

const axiosError = (
  status: number,
  method = "get",
  headers: Record<string, string> = {}
) =>
  ({
    config: { url: "/repositories/foo/bar", method },
    response: { status, headers },
  }) as unknown as AxiosError;

describe("parseRetryAfterMs", () => {
  it("reads a delay in seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-07-25T10:00:00Z");
    expect(parseRetryAfterMs("Sat, 25 Jul 2026 10:00:05 GMT", () => now)).toBe(
      5000
    );
  });

  it("returns undefined for a missing or unparseable header", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("computeRetryDelayMs", () => {
  it("honours Retry-After over backoff", () => {
    expect(computeRetryDelayMs(1, "3", { random: () => 0 })).toBe(3000);
  });

  it("backs off exponentially without a header", () => {
    const opts = { baseDelayMs: 100, random: () => 0 };
    expect(computeRetryDelayMs(1, undefined, opts)).toBe(100);
    expect(computeRetryDelayMs(2, undefined, opts)).toBe(200);
    expect(computeRetryDelayMs(3, undefined, opts)).toBe(400);
  });

  it("never exceeds maxDelayMs", () => {
    expect(
      computeRetryDelayMs(10, "9999", { maxDelayMs: 5000, random: () => 0 })
    ).toBe(5000);
  });
});

describe("isRetryable", () => {
  it("retries transient statuses on reads", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(isRetryable(axiosError(status))).toBe(true);
    }
  });

  it("does not retry writes — replaying a POST could double-post a comment", () => {
    expect(isRetryable(axiosError(429, "post"))).toBe(false);
  });

  it("does not retry client errors", () => {
    expect(isRetryable(axiosError(404))).toBe(false);
    expect(isRetryable(axiosError(401))).toBe(false);
  });
});

describe("attachRetryInterceptor", () => {
  it("replays the request after a 429 instead of losing collected pages", async () => {
    const { api, handler } = createMockApi();
    const sleep = jest.fn(async () => {});
    attachRetryInterceptor(api, createLogger(), { sleep, random: () => 0 });

    const error = axiosError(429, "get", { "retry-after": "1" });
    const result = await handler()(error);

    expect(sleep).toHaveBeenCalledWith(1000);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: { ok: true } });
  });

  it("gives up after maxRetries and rethrows", async () => {
    const { api, handler } = createMockApi();
    attachRetryInterceptor(api, createLogger(), {
      maxRetries: 2,
      sleep: async () => {},
      random: () => 0,
    });

    const error = axiosError(429);
    await handler()(error); // attempt 1
    await handler()(error); // attempt 2
    await expect(handler()(error)).rejects.toBe(error); // exhausted

    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-retryable failures untouched", async () => {
    const { api, handler } = createMockApi();
    attachRetryInterceptor(api, createLogger(), { sleep: async () => {} });

    const error = axiosError(404);
    await expect(handler()(error)).rejects.toBe(error);
    expect(api.request).not.toHaveBeenCalled();
  });

  it("can be disabled with maxRetries=0", async () => {
    const { api, handler } = createMockApi();
    attachRetryInterceptor(api, createLogger(), {
      maxRetries: 0,
      sleep: async () => {},
    });

    const error = axiosError(429);
    await expect(handler()(error)).rejects.toBe(error);
    expect(api.request).not.toHaveBeenCalled();
  });
});
