import { normalizeMergeStrategy } from "../src/merge-strategy.js";

describe("normalizeMergeStrategy", () => {
  it("converts the hyphenated aliases Bitbucket rejects", () => {
    expect(normalizeMergeStrategy("merge-commit")).toBe("merge_commit");
    expect(normalizeMergeStrategy("fast-forward")).toBe("fast_forward");
  });

  it("passes through the canonical underscore forms", () => {
    expect(normalizeMergeStrategy("merge_commit")).toBe("merge_commit");
    expect(normalizeMergeStrategy("squash")).toBe("squash");
    expect(normalizeMergeStrategy("fast_forward")).toBe("fast_forward");
  });

  it("accepts every strategy Bitbucket lists, with hyphenated aliases", () => {
    for (const strategy of [
      "squash_fast_forward",
      "rebase_fast_forward",
      "rebase_merge",
    ]) {
      expect(normalizeMergeStrategy(strategy)).toBe(strategy);
      expect(normalizeMergeStrategy(strategy.replace(/_/g, "-"))).toBe(strategy);
    }
  });

  it("tolerates case and surrounding whitespace", () => {
    expect(normalizeMergeStrategy(" Merge-Commit ")).toBe("merge_commit");
  });

  it("returns undefined when no strategy is given", () => {
    expect(normalizeMergeStrategy(undefined)).toBeUndefined();
    expect(normalizeMergeStrategy("")).toBeUndefined();
  });

  it("rejects unknown strategies instead of forwarding them", () => {
    expect(() => normalizeMergeStrategy("rebase")).toThrow(
      /Invalid merge strategy "rebase"/
    );
  });
});
