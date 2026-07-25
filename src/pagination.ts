import type { AxiosInstance } from "axios";
import type winston from "winston";

export const BITBUCKET_DEFAULT_PAGELEN = 10;
export const BITBUCKET_MAX_PAGELEN = 100;
/**
 * `/pullrequests` and `/pullrequests/{id}/activity` reject anything above 50
 * with `400 Invalid pagelen` — verified against api.bitbucket.org, the docs do
 * not mention it. Every other collection accepts 100.
 */
export const BITBUCKET_PULLREQUEST_MAX_PAGELEN = 50;
export const BITBUCKET_ALL_ITEMS_CAP = 1000;

export interface PaginationRequestOptions {
  pagelen?: number;
  page?: number;
  all?: boolean;
  params?: Record<string, any>;
  defaultPagelen?: number;
  /** Endpoint-specific ceiling for `pagelen`. Defaults to Bitbucket's 100. */
  maxPagelen?: number;
  maxItems?: number;
  description?: string;
}

export interface PaginatedValuesResult<T> {
  values: T[];
  page?: number;
  pagelen: number;
  next?: string;
  fetchedPages: number;
  totalFetched: number;
  previous?: string;
  /**
   * True when more items exist on the server than were returned, because the
   * `maxItems` cap was hit — either while following `next` links or by trimming
   * a single over-long page. Without this the caller cannot tell a complete
   * result from a silently truncated one.
   */
  truncated: boolean;
  /** Non-fatal note about how the request options were interpreted. */
  warning?: string;
}

interface PendingRequestConfig {
  url: string;
  params?: Record<string, any>;
}

export interface PaginationArgs {
  pagelen?: number;
  page?: number;
  all?: boolean;
  /** Deprecated alias kept for backward compatibility. Treated as `maxItems`. */
  limit?: number;
  maxItems?: number;
  /** Endpoint-specific ceiling for `pagelen`. Defaults to Bitbucket's 100. */
  maxPagelen?: number;
}

export interface ResolvedPagination {
  pagelen?: number;
  page?: number;
  all?: boolean;
  maxItems?: number;
  maxPagelen?: number;
}

/**
 * Turn the tool-level pagination arguments into paginator options.
 *
 * `limit` used to be a plain alias for `pagelen`, so `limit: 500` quietly
 * returned 100 items (Bitbucket's page cap) and nothing said so. It is now a
 * total-item budget: the page size is derived from it and pages are followed
 * automatically until the budget is spent.
 */
export function resolvePagination(args: PaginationArgs): ResolvedPagination {
  const {
    pagelen,
    page,
    all,
    limit,
    maxItems,
    maxPagelen = BITBUCKET_MAX_PAGELEN,
  } = args;
  const budget = maxItems ?? limit;

  const explicitPagelen =
    pagelen !== undefined ? Math.min(pagelen, maxPagelen) : undefined;
  const budgetPagelen =
    budget !== undefined && budget > 0
      ? Math.min(budget, maxPagelen)
      : undefined;

  // Never ask Bitbucket for a page bigger than the budget can keep: passing both
  // `pagelen: 100` and `maxItems: 3` used to fetch (and return) a full 100-item
  // page, because the budget only ever gated page-following.
  //
  // An explicit `page` is the exception — there the page size fixes the window,
  // so shrinking it would hand back a different slice of the collection than the
  // caller asked for. The budget is enforced by trimming in `fetchValues`.
  const resolvedPagelen =
    explicitPagelen === undefined
      ? budgetPagelen
      : page === undefined && budgetPagelen !== undefined
        ? Math.min(explicitPagelen, budgetPagelen)
        : explicitPagelen;

  const effectivePagelen = resolvedPagelen ?? BITBUCKET_DEFAULT_PAGELEN;
  // An explicit `all` always wins; otherwise a budget larger than one page
  // implies the caller wants those pages followed.
  const resolvedAll =
    all ??
    (budget !== undefined && page === undefined && budget > effectivePagelen
      ? true
      : undefined);

  return {
    pagelen: resolvedPagelen,
    page,
    all: resolvedAll,
    maxItems: budget,
    maxPagelen,
  };
}

export class BitbucketPaginator {
  constructor(
    private readonly api: AxiosInstance,
    private readonly logger: winston.Logger
  ) {}

  async fetchValues<T>(
    path: string,
    options: PaginationRequestOptions = {}
  ): Promise<PaginatedValuesResult<T>> {
    const {
      pagelen,
      page,
      all = false,
      params = {},
      defaultPagelen = BITBUCKET_DEFAULT_PAGELEN,
      maxPagelen = BITBUCKET_MAX_PAGELEN,
      maxItems = BITBUCKET_ALL_ITEMS_CAP,
      description,
    } = options;

    const resolvedPagelen = this.normalizePagelen(
      pagelen ?? defaultPagelen,
      maxPagelen
    );
    const requestParams: Record<string, any> = {
      ...params,
      pagelen: resolvedPagelen,
    };
    if (page !== undefined) {
      requestParams.page = page;
    }

    const shouldFetchAll = all === true && page === undefined;
    // `all` combined with an explicit `page` silently returned a single page.
    // Keep that behaviour (it is the safe one) but tell the caller about it.
    const warning =
      all === true && page !== undefined
        ? "`all` was ignored because an explicit `page` was provided. Omit `page` to auto-follow next links."
        : undefined;
    const requestDescriptor: PendingRequestConfig = {
      url: path,
      params: requestParams,
    };

    if (!shouldFetchAll) {
      const response = await this.performRequest(
        requestDescriptor,
        description
      );
      const values = this.extractValues<T>(response.data);
      // The budget has to be enforced here too, not just while following `next`
      // links: with an explicit `page` the page size is pinned, and some
      // collections ignore `pagelen` outright, so a page can still overshoot.
      // Until this existed, `maxItems: 3` on a 50-item page returned all 50.
      const trimmed = values.length > maxItems;
      const capped = trimmed ? values.slice(0, maxItems) : values;
      const notes = warning ? [warning] : [];
      if (trimmed) {
        // `next` is the server's link to the page *after* this one, so resuming
        // from it would skip whatever the trim dropped. Say so rather than let
        // the caller stitch together a collection with a hole in it.
        notes.push(
          `\`maxItems\` (${maxItems}) trimmed this page from ${values.length} items; \`next\` starts at the following page, so resuming there would skip the trimmed items. Raise maxItems, or page through with pagelen instead.`
        );
      }
      return {
        values: capped,
        page: response.data?.page ?? page,
        pagelen: response.data?.pagelen ?? resolvedPagelen,
        next: response.data?.next,
        previous: response.data?.previous,
        fetchedPages: 1,
        totalFetched: capped.length,
        truncated: trimmed,
        warning: notes.length ? notes.join(" ") : undefined,
      };
    }

    const aggregated: T[] = [];
    let fetchedPages = 0;
    let lastNext: string | undefined;
    let nextRequest: PendingRequestConfig | undefined = requestDescriptor;
    let firstPageMeta: {
      page?: number;
      pagelen: number;
      previous?: string;
    } = { pagelen: resolvedPagelen };

    while (nextRequest && aggregated.length < maxItems) {
      const response = await this.performRequest(nextRequest, description, {
        page: fetchedPages + 1,
      });
      fetchedPages += 1;

      if (fetchedPages === 1) {
        firstPageMeta = {
          page: response.data?.page,
          pagelen: response.data?.pagelen ?? resolvedPagelen,
          previous: response.data?.previous,
        };
      }

      const values = this.extractValues<T>(response.data);
      aggregated.push(...values);
      lastNext = response.data?.next;

      if (!lastNext) {
        nextRequest = undefined;
        break;
      }

      if (aggregated.length >= maxItems) {
        this.logger.debug("Bitbucket pagination cap reached", {
          description: description ?? path,
          maxItems,
        });
        nextRequest = undefined;
        break;
      }

      this.logger.debug("Following Bitbucket pagination next link", {
        description: description ?? path,
        next: response.data.next,
        fetchedPages,
        totalFetched: aggregated.length,
      });

      nextRequest = { url: lastNext };
    }

    // Truncated either because the cap stopped us while the server still had a
    // `next` link, or because the last page overshot the cap and got trimmed.
    const truncated =
      aggregated.length > maxItems ||
      (aggregated.length >= maxItems && Boolean(lastNext));

    if (aggregated.length > maxItems) {
      aggregated.length = maxItems;
    }

    return {
      values: aggregated,
      page: firstPageMeta.page,
      pagelen: firstPageMeta.pagelen,
      previous: firstPageMeta.previous,
      // Surface the unfollowed link so the caller can resume instead of
      // silently believing the collection ended here.
      next: truncated ? lastNext : undefined,
      fetchedPages,
      totalFetched: aggregated.length,
      truncated,
      warning,
    };
  }

  private async performRequest(
    request: PendingRequestConfig,
    description?: string,
    extra?: Record<string, any>
  ) {
    this.logger.debug("Calling Bitbucket API", {
      description: description ?? request.url,
      url: request.url,
      params: request.params,
      ...extra,
    });
    const config = request.params ? { params: request.params } : undefined;
    return this.api.get(request.url, config);
  }

  private extractValues<T>(data: any): T[] {
    if (Array.isArray(data?.values)) {
      return data.values as T[];
    }
    if (Array.isArray(data)) {
      return data as T[];
    }
    return [];
  }

  private normalizePagelen(
    value?: number,
    maxPagelen: number = BITBUCKET_MAX_PAGELEN
  ): number {
    if (value === undefined || Number.isNaN(value)) {
      return Math.min(BITBUCKET_DEFAULT_PAGELEN, maxPagelen);
    }
    const integer = Math.floor(value);
    if (!Number.isFinite(integer) || integer < 1) {
      return 1;
    }
    return Math.min(integer, maxPagelen);
  }
}
