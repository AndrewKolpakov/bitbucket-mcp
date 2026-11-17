import {
  toReviewerRef,
  sameReviewer,
  computeReviewers,
  findUnmatchedRemovals,
  buildPullRequestUpdate,
  buildMergeBody,
  parseMergeTaskId,
  buildStateQuery,
  PULL_REQUEST_STATES,
} from "../src/pull-request-ops.js";

const U1 = "11111111-2222-3333-4444-555555555555";
const U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const U3 = "99999999-8888-7777-6666-555555555555";

describe("toReviewerRef", () => {
  it("keeps a braced uuid as given", () => {
    expect(toReviewerRef(`{${U1}}`)).toEqual({ uuid: `{${U1}}` });
  });

  it("wraps a bare uuid in braces", () => {
    expect(toReviewerRef(U1)).toEqual({ uuid: `{${U1}}` });
    expect(toReviewerRef(U2.toUpperCase())).toEqual({ uuid: `{${U2.toUpperCase()}}` });
  });

  it("passes account ids through", () => {
    expect(toReviewerRef("557058:abcd-1234")).toEqual({ account_id: "557058:abcd-1234" });
    expect(toReviewerRef("5b10a2844c20165700ede21g")).toEqual({
      account_id: "5b10a2844c20165700ede21g",
    });
  });

  it("trims whitespace", () => {
    expect(toReviewerRef(`  ${U1}  `)).toEqual({ uuid: `{${U1}}` });
    expect(toReviewerRef(` {${U1}} `)).toEqual({ uuid: `{${U1}}` });
    expect(toReviewerRef("  557058:abcd  ")).toEqual({ account_id: "557058:abcd" });
  });

  it("throws on empty, whitespace-only or non-string input", () => {
    expect(() => toReviewerRef("")).toThrow("Empty reviewer id");
    expect(() => toReviewerRef("   ")).toThrow("Empty reviewer id");
    expect(() => toReviewerRef(undefined as unknown as string)).toThrow("Empty reviewer id");
  });
});

describe("sameReviewer", () => {
  it("compares uuids ignoring braces", () => {
    expect(sameReviewer({ uuid: `{${U1}}` }, { uuid: U1 })).toBe(true);
    expect(sameReviewer({ uuid: `{${U1}}` }, { uuid: `{${U1}}` })).toBe(true);
  });

  it("compares uuids case-insensitively", () => {
    expect(sameReviewer({ uuid: `{${U2}}` }, { uuid: `{${U2.toUpperCase()}}` })).toBe(true);
  });

  it("returns false for different uuids", () => {
    expect(sameReviewer({ uuid: `{${U1}}` }, { uuid: `{${U2}}` })).toBe(false);
  });

  it("compares account ids exactly", () => {
    expect(sameReviewer({ account_id: "abc:1" }, { account_id: "abc:1" })).toBe(true);
    expect(sameReviewer({ account_id: "abc:1" }, { account_id: "ABC:1" })).toBe(false);
    expect(sameReviewer({ account_id: "abc:1" }, { account_id: "abc:2" })).toBe(false);
  });

  it("is false when one has only uuid and the other only account_id", () => {
    expect(sameReviewer({ uuid: `{${U1}}` }, { account_id: "abc:1" })).toBe(false);
    expect(sameReviewer({ account_id: "abc:1" }, { uuid: `{${U1}}` })).toBe(false);
  });

  it("matches an account with both fields against a ref with only account_id", () => {
    expect(sameReviewer({ uuid: `{${U1}}`, account_id: "abc:1" }, { account_id: "abc:1" })).toBe(true);
  });

  it("is false when neither has an id", () => {
    expect(sameReviewer({}, {})).toBe(false);
  });
});

describe("computeReviewers", () => {
  const current = [
    { uuid: `{${U1}}`, account_id: "acc:1", display_name: "One" },
    { uuid: `{${U2}}`, account_id: "acc:2" },
  ];

  it("returns undefined when no change is requested", () => {
    expect(computeReviewers(current, {})).toBeUndefined();
  });

  describe("set", () => {
    it("replaces current reviewers", () => {
      expect(computeReviewers(current, { set: [U3, "acc:9"] })).toEqual([
        { uuid: `{${U3}}` },
        { account_id: "acc:9" },
      ]);
    });

    it("de-duplicates keeping the first occurrence", () => {
      expect(computeReviewers([], { set: [U1, `{${U1.toUpperCase()}}`, "acc:1", "acc:1"] })).toEqual([
        { uuid: `{${U1}}` },
        { account_id: "acc:1" },
      ]);
    });

    it("clears reviewers with an empty array", () => {
      expect(computeReviewers(current, { set: [] })).toEqual([]);
    });

    it("throws when combined with add", () => {
      expect(() => computeReviewers(current, { set: [U1], add: [U2] })).toThrow(/reviewers/);
      expect(() => computeReviewers(current, { set: [U1], add: [U2] })).toThrow(
        /addReviewers\/removeReviewers/,
      );
    });

    it("throws when combined with remove", () => {
      expect(() => computeReviewers(current, { set: [U1], remove: [U2] })).toThrow(/reviewers/);
    });

    it("throws when combined with an empty add/remove array", () => {
      expect(() => computeReviewers(current, { set: [], add: [] })).toThrow(/reviewers/);
    });
  });

  describe("add / remove", () => {
    it("maps current entries to refs carrying uuid when present", () => {
      expect(computeReviewers(current, { add: [] })).toEqual([
        { uuid: `{${U1}}` },
        { uuid: `{${U2}}` },
      ]);
    });

    it("uses account_id when the current entry has no uuid", () => {
      expect(computeReviewers([{ account_id: "acc:5" }], { add: [] })).toEqual([
        { account_id: "acc:5" },
      ]);
    });

    it("appends new reviewers at the end", () => {
      expect(computeReviewers(current, { add: [U3, "acc:9"] })).toEqual([
        { uuid: `{${U1}}` },
        { uuid: `{${U2}}` },
        { uuid: `{${U3}}` },
        { account_id: "acc:9" },
      ]);
    });

    it("does not duplicate an existing reviewer (braces, case-insensitive uuid)", () => {
      expect(computeReviewers(current, { add: [U1, `{${U2.toUpperCase()}}`] })).toEqual([
        { uuid: `{${U1}}` },
        { uuid: `{${U2}}` },
      ]);
    });

    it("does not duplicate a reviewer added by account_id when current carries both ids", () => {
      expect(computeReviewers(current, { add: ["acc:1"] })).toEqual([
        { uuid: `{${U1}}` },
        { uuid: `{${U2}}` },
      ]);
      expect(
        computeReviewers([{ uuid: "{U1}", account_id: "557058:abc" }], { add: ["557058:abc"] })
      ).toEqual([{ uuid: "{U1}" }]);
    });

    it("does not duplicate within add", () => {
      expect(computeReviewers([], { add: [U3, `{${U3}}`] })).toEqual([{ uuid: `{${U3}}` }]);
    });

    it("removes by braced uuid", () => {
      expect(computeReviewers(current, { remove: [`{${U1}}`] })).toEqual([{ uuid: `{${U2}}` }]);
    });

    it("removes by bare uuid", () => {
      expect(computeReviewers(current, { remove: [U2] })).toEqual([{ uuid: `{${U1}}` }]);
    });

    it("removes by account_id against entries that carry both ids", () => {
      expect(computeReviewers(current, { remove: ["acc:1"] })).toEqual([{ uuid: `{${U2}}` }]);
    });

    it("removes everything when all are removed", () => {
      expect(computeReviewers(current, { remove: [U1, "acc:2"] })).toEqual([]);
    });

    it("computeReviewers itself leaves the list unchanged for removals that match nobody (callers use findUnmatchedRemovals)", () => {
      expect(computeReviewers(current, { remove: [U3, "acc:zzz"] })).toEqual([
        { uuid: `{${U1}}` },
        { uuid: `{${U2}}` },
      ]);
    });

    it("drops current entries with neither uuid nor account_id", () => {
      expect(computeReviewers([{ display_name: "ghost" }, { uuid: `{${U1}}` }], { add: [] })).toEqual([
        { uuid: `{${U1}}` },
      ]);
    });

    it("applies remove then add and preserves order", () => {
      expect(computeReviewers(current, { remove: ["acc:1"], add: [U3] })).toEqual([
        { uuid: `{${U2}}` },
        { uuid: `{${U3}}` },
      ]);
    });

    it("can re-add a reviewer that was just removed", () => {
      expect(computeReviewers(current, { remove: [U1], add: [U1] })).toEqual([
        { uuid: `{${U2}}` },
        { uuid: `{${U1}}` },
      ]);
    });

    it("de-duplicates the result", () => {
      expect(
        computeReviewers([{ uuid: `{${U1}}` }, { uuid: U1.toUpperCase() }], { add: [] }),
      ).toEqual([{ uuid: `{${U1}}` }]);
    });
  });
});

describe("buildPullRequestUpdate", () => {
  it("includes only defined fields", () => {
    expect(buildPullRequestUpdate({ title: "T" })).toEqual({ title: "T" });
    expect(buildPullRequestUpdate({ description: "D" })).toEqual({ description: "D" });
  });

  it("builds the destination shape", () => {
    expect(buildPullRequestUpdate({ destinationBranch: "develop" })).toEqual({
      destination: { branch: { name: "develop" } },
    });
  });

  it("keeps close_source_branch false", () => {
    const body = buildPullRequestUpdate({ closeSourceBranch: false });
    expect(body).toEqual({ close_source_branch: false });
    expect("close_source_branch" in body).toBe(true);
  });

  it("keeps close_source_branch true", () => {
    expect(buildPullRequestUpdate({ closeSourceBranch: true })).toEqual({
      close_source_branch: true,
    });
  });

  it("keeps an empty reviewers array", () => {
    expect(buildPullRequestUpdate({ reviewers: [] })).toEqual({ reviewers: [] });
  });

  it("combines all fields", () => {
    expect(
      buildPullRequestUpdate({
        title: "T",
        description: "D",
        destinationBranch: "main",
        closeSourceBranch: true,
        reviewers: [{ uuid: `{${U1}}` }],
      }),
    ).toEqual({
      title: "T",
      description: "D",
      destination: { branch: { name: "main" } },
      close_source_branch: true,
      reviewers: [{ uuid: `{${U1}}` }],
    });
  });

  it("omits undefined keys entirely", () => {
    const body = buildPullRequestUpdate({ title: "T", description: undefined });
    expect(Object.keys(body)).toEqual(["title"]);
  });

  it("throws when there is nothing to update", () => {
    expect(() => buildPullRequestUpdate({})).toThrow("Nothing to update");
    expect(() =>
      buildPullRequestUpdate({ title: undefined, reviewers: undefined }),
    ).toThrow("Nothing to update");
  });
});

describe("buildMergeBody", () => {
  it("returns an empty body for empty input", () => {
    expect(buildMergeBody({})).toEqual({});
  });

  it("omits an empty message", () => {
    expect(buildMergeBody({ message: "" })).toEqual({});
  });

  it("includes a non-empty message", () => {
    expect(buildMergeBody({ message: "Merge it" })).toEqual({ message: "Merge it" });
  });

  it("includes the strategy", () => {
    expect(buildMergeBody({ strategy: "squash" })).toEqual({ merge_strategy: "squash" });
    expect(buildMergeBody({ strategy: "merge_commit" })).toEqual({
      merge_strategy: "merge_commit",
    });
  });

  it("sends close_source_branch false", () => {
    const body = buildMergeBody({ closeSourceBranch: false });
    expect(body).toEqual({ close_source_branch: false });
    expect("close_source_branch" in body).toBe(true);
  });

  it("sends close_source_branch true", () => {
    expect(buildMergeBody({ closeSourceBranch: true })).toEqual({ close_source_branch: true });
  });

  it("omits close_source_branch when undefined", () => {
    expect("close_source_branch" in buildMergeBody({ message: "m" })).toBe(false);
  });

  it("combines all fields", () => {
    expect(
      buildMergeBody({ message: "m", strategy: "fast_forward", closeSourceBranch: true }),
    ).toEqual({ message: "m", merge_strategy: "fast_forward", close_source_branch: true });
  });
});

describe("parseMergeTaskId", () => {
  it("parses an absolute URL", () => {
    expect(
      parseMergeTaskId(
        "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/12/merge/task-status/abc-123",
      ),
    ).toBe("abc-123");
  });

  it("parses a relative path", () => {
    expect(
      parseMergeTaskId("/2.0/repositories/ws/repo/pullrequests/12/merge/task-status/abc-123"),
    ).toBe("abc-123");
  });

  it("strips query string and fragment", () => {
    expect(parseMergeTaskId("/pullrequests/12/merge/task-status/abc-123?x=1")).toBe("abc-123");
    expect(parseMergeTaskId("/pullrequests/12/merge/task-status/abc-123#frag")).toBe("abc-123");
  });

  it("decodes a percent-encoded id", () => {
    expect(parseMergeTaskId("/pullrequests/12/merge/task-status/a%20b%2Fc")).toBe("a b/c");
  });

  it("returns undefined for missing or unrelated input", () => {
    expect(parseMergeTaskId(undefined)).toBeUndefined();
    expect(parseMergeTaskId(null)).toBeUndefined();
    expect(parseMergeTaskId("")).toBeUndefined();
    expect(parseMergeTaskId("https://api.bitbucket.org/2.0/repositories/ws/repo")).toBeUndefined();
    expect(parseMergeTaskId("/pullrequests/12/merge/task-status/")).toBeUndefined();
  });
});

describe("buildStateQuery", () => {
  it("exposes the valid states", () => {
    expect([...PULL_REQUEST_STATES]).toEqual(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
  });

  it("returns an empty string for undefined", () => {
    expect(buildStateQuery(undefined)).toBe("");
  });

  it("returns an empty string for an empty array or blanks", () => {
    expect(buildStateQuery([])).toBe("");
    expect(buildStateQuery(["", "  "])).toBe("");
    expect(buildStateQuery("  ")).toBe("");
  });

  it("uppercases a single string", () => {
    expect(buildStateQuery("open")).toBe("state=OPEN");
  });

  it("normalizes, trims and de-duplicates an array", () => {
    expect(buildStateQuery(["OPEN", "merged", " MERGED "])).toBe("state=OPEN&state=MERGED");
  });

  it("preserves order", () => {
    expect(buildStateQuery(["declined", "open"])).toBe("state=DECLINED&state=OPEN");
  });

  it("accepts all four states", () => {
    expect(buildStateQuery(["open", "merged", "declined", "superseded"])).toBe(
      "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED",
    );
  });

  it("never uses the state[] form", () => {
    expect(buildStateQuery(["open", "merged"])).not.toContain("[]");
  });

  it("throws naming the invalid value and the valid ones", () => {
    expect(() => buildStateQuery("bogus")).toThrow(/BOGUS/i);
    expect(() => buildStateQuery(["open", "nope"])).toThrow(/NOPE/i);
    expect(() => buildStateQuery("bogus")).toThrow(/OPEN/);
  });
});

describe("findUnmatchedRemovals", () => {
  const current = [
    { uuid: `{${U1}}`, account_id: "acc:1" },
    { uuid: `{${U2}}`, account_id: "acc:2" },
  ];

  it("returns nothing when every id matches (uuid, bare uuid, account_id)", () => {
    expect(findUnmatchedRemovals(current, [`{${U1}}`, U2, "acc:1"])).toEqual([]);
  });

  it("returns trimmed raw ids that match nobody", () => {
    expect(findUnmatchedRemovals(current, [U3, " acc:zzz ", "acc:2"])).toEqual([U3, "acc:zzz"]);
  });

  it("handles undefined and empty input", () => {
    expect(findUnmatchedRemovals(current, undefined)).toEqual([]);
    expect(findUnmatchedRemovals(current, [])).toEqual([]);
    expect(findUnmatchedRemovals([], ["acc:1"])).toEqual(["acc:1"]);
  });
});
