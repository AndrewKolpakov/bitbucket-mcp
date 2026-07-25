import { resolvePagination } from "../src/pagination.js";

describe("resolvePagination", () => {
  it("treats limit as a total budget, not a page size", () => {
    // The old behaviour mapped limit -> pagelen, so limit: 500 returned 100
    // items and said nothing about the other 400.
    expect(resolvePagination({ limit: 500 })).toEqual({
      pagelen: 100,
      page: undefined,
      all: true,
      maxItems: 500,
      maxPagelen: 100,
    });
  });

  it("keeps a single page when the budget fits in one", () => {
    expect(resolvePagination({ limit: 25 })).toEqual({
      pagelen: 25,
      page: undefined,
      all: undefined,
      maxItems: 25,
      maxPagelen: 100,
    });
  });

  it("prefers maxItems over the deprecated limit alias", () => {
    expect(resolvePagination({ limit: 10, maxItems: 300 })).toMatchObject({
      pagelen: 100,
      all: true,
      maxItems: 300,
    });
  });

  it("respects an explicit pagelen while still honouring the budget", () => {
    expect(resolvePagination({ pagelen: 20, maxItems: 200 })).toEqual({
      pagelen: 20,
      page: undefined,
      all: true,
      maxItems: 200,
      maxPagelen: 100,
    });
  });

  it("does not auto-follow pages when an explicit page is requested", () => {
    expect(resolvePagination({ limit: 500, page: 3 })).toEqual({
      pagelen: 100,
      page: 3,
      all: undefined,
      maxItems: 500,
      maxPagelen: 100,
    });
  });

  it("lets an explicit all=false win over the budget", () => {
    expect(resolvePagination({ limit: 500, all: false })).toMatchObject({
      all: false,
      maxItems: 500,
    });
  });

  it("respects an endpoint-specific pagelen ceiling", () => {
    // /pullrequests answers 400 Invalid pagelen above 50, so a 150-item
    // budget must page by 50, not by Bitbucket's global 100.
    expect(resolvePagination({ limit: 150, maxPagelen: 50 })).toMatchObject({
      pagelen: 50,
      all: true,
      maxItems: 150,
      maxPagelen: 50,
    });
  });

  it("clamps an explicit pagelen to the endpoint ceiling", () => {
    expect(resolvePagination({ pagelen: 100, maxPagelen: 50 })).toMatchObject({
      pagelen: 50,
    });
  });

  it("passes through untouched when nothing is specified", () => {
    expect(resolvePagination({})).toEqual({
      pagelen: undefined,
      page: undefined,
      all: undefined,
      maxItems: undefined,
      maxPagelen: 100,
    });
  });
});
