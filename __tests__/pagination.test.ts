import { jest } from "@jest/globals";
import type { AxiosInstance } from "axios";
import { BitbucketPaginator, BITBUCKET_MAX_PAGELEN } from "../src/pagination.js";

const createMockAxios = () => {
  return {
    get: jest.fn(),
  } as unknown as AxiosInstance & { get: jest.Mock };
};

const createMockLogger = () => ({
  debug: jest.fn(),
}) as any;

describe("BitbucketPaginator", () => {
  it("respects pagelen and page arguments", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    (axios.get as any).mockResolvedValue({
      data: { values: [{ id: 1 }], page: 1, pagelen: 1 },
    });

    const result = await paginator.fetchValues("/test", {
      pagelen: 1,
      page: 1,
      description: "unit",
    });

    expect(axios.get).toHaveBeenCalledWith("/test", {
      params: { pagelen: 1, page: 1 },
    });
    expect(result.values).toHaveLength(1);
    expect(result.page).toBe(1);
  });

  it("caps pagelen to Bitbucket maximum", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    (axios.get as any).mockResolvedValue({
      data: { values: [], pagelen: BITBUCKET_MAX_PAGELEN },
    });

    await paginator.fetchValues("/test", { pagelen: BITBUCKET_MAX_PAGELEN + 25 });

    expect(axios.get).toHaveBeenCalledWith("/test", {
      params: { pagelen: BITBUCKET_MAX_PAGELEN },
    });
  });

  it("follows next links when all=true", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    (axios.get as any)
      .mockResolvedValueOnce({
        data: {
          values: [{ id: 1 }],
          next: "https://api.bitbucket.org/2.0/test?page=2",
        },
      })
      .mockResolvedValueOnce({ data: { values: [{ id: 2 }] } });

    const result = await paginator.fetchValues<{ id: number }>("/test", {
      all: true,
    });

    expect(axios.get).toHaveBeenNthCalledWith(1, "/test", {
      params: { pagelen: 10 },
    });
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      "https://api.bitbucket.org/2.0/test?page=2",
      undefined
    );
    expect(result.values.map((item) => item.id)).toEqual([1, 2]);
    expect(result.fetchedPages).toBe(2);
    expect(result.totalFetched).toBe(2);
    // The collection ended on its own — nothing was withheld.
    expect(result.truncated).toBe(false);
    expect(result.next).toBeUndefined();
  });

  it("flags truncation and keeps the unfollowed next link when maxItems is hit", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    (axios.get as any)
      .mockResolvedValueOnce({
        data: {
          values: [{ id: 1 }, { id: 2 }],
          next: "https://api.bitbucket.org/2.0/test?page=2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          values: [{ id: 3 }, { id: 4 }],
          next: "https://api.bitbucket.org/2.0/test?page=3",
        },
      });

    const result = await paginator.fetchValues<{ id: number }>("/test", {
      all: true,
      pagelen: 2,
      maxItems: 4,
    });

    expect(result.values.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(result.truncated).toBe(true);
    expect(result.next).toBe("https://api.bitbucket.org/2.0/test?page=3");
    // Page 3 must not have been requested.
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("flags truncation when the final page overshoots maxItems", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    (axios.get as any).mockResolvedValueOnce({
      data: { values: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    });

    const result = await paginator.fetchValues<{ id: number }>("/test", {
      all: true,
      maxItems: 2,
    });

    expect(result.values).toHaveLength(2);
    expect(result.totalFetched).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("trims a single page that overshoots maxItems", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    // A server page bigger than the budget: happens with an explicit `page` (the
    // page size is pinned) or on collections that ignore `pagelen`.
    (axios.get as any).mockResolvedValue({
      data: {
        values: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
        page: 2,
        pagelen: 50,
        next: "https://api.bitbucket.org/2.0/test?page=3",
      },
    });

    const result = await paginator.fetchValues<{ id: number }>("/test", {
      page: 2,
      pagelen: 50,
      maxItems: 2,
    });

    expect(result.values.map((item) => item.id)).toEqual([1, 2]);
    expect(result.totalFetched).toBe(2);
    expect(result.truncated).toBe(true);
    // The caller must be told that `next` skips past the trimmed items.
    expect(result.warning).toMatch(/trimmed this page from 4 items/);
  });

  it("leaves a page that fits the budget untouched and unflagged", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    (axios.get as any).mockResolvedValue({
      data: { values: [{ id: 1 }, { id: 2 }], page: 1, pagelen: 10 },
    });

    const result = await paginator.fetchValues<{ id: number }>("/test", {
      maxItems: 5,
    });

    expect(result.values).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("warns instead of silently ignoring all when page is also given", async () => {
    const axios = createMockAxios();
    const logger = createMockLogger();
    const paginator = new BitbucketPaginator(axios, logger);

    (axios.get as any).mockResolvedValue({
      data: {
        values: [{ id: 1 }],
        page: 2,
        next: "https://api.bitbucket.org/2.0/test?page=3",
      },
    });

    const result = await paginator.fetchValues("/test", { all: true, page: 2 });

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(result.warning).toMatch(/`all` was ignored/);
    expect(result.next).toBe("https://api.bitbucket.org/2.0/test?page=3");
  });
});
