import {
  isPendingReviewer,
  rankPendingReviewPRs,
  repositorySlug,
} from "../src/pending-review.js";

describe("repositorySlug", () => {
  it("prefers the slug over the display name", () => {
    expect(
      repositorySlug({
        slug: "ai-chat",
        name: "AI-Chat",
        full_name: "managegocom/ai-chat",
      })
    ).toBe("ai-chat");
  });

  it("falls back to the full_name tail when slug is absent", () => {
    // Using `name` here produced "AI-Chat" and a 404 on every request.
    expect(
      repositorySlug({ name: "AI-Chat", full_name: "managegocom/ai-chat" })
    ).toBe("ai-chat");
  });

  it("falls back to name only as a last resort", () => {
    expect(repositorySlug({ name: "legacy-repo" })).toBe("legacy-repo");
  });

  it("returns undefined when nothing identifies the repository", () => {
    expect(repositorySlug({})).toBeUndefined();
  });
});

describe("isPendingReviewer", () => {
  const pr = (participants: any[]) => ({ id: 1, participants });

  it("matches an unapproved reviewer", () => {
    expect(
      isPendingReviewer(
        pr([{ user: { nickname: "jdoe" }, role: "REVIEWER", approved: false }]),
        "jdoe"
      )
    ).toBe(true);
  });

  it("ignores reviewers who already approved", () => {
    expect(
      isPendingReviewer(
        pr([{ user: { nickname: "jdoe" }, role: "REVIEWER", approved: true }]),
        "jdoe"
      )
    ).toBe(false);
  });

  it("ignores participants who are not reviewers", () => {
    expect(
      isPendingReviewer(
        pr([
          { user: { nickname: "jdoe" }, role: "PARTICIPANT", approved: false },
        ]),
        "jdoe"
      )
    ).toBe(false);
  });

  it("tolerates a missing participants array", () => {
    expect(isPendingReviewer({ id: 2 }, "jdoe")).toBe(false);
  });
});

describe("rankPendingReviewPRs", () => {
  it("sorts before slicing", () => {
    // Scan order deliberately puts the newest PR last: the old
    // slice-then-sort dropped it before sorting ever happened.
    const prs = [
      { id: 1, updated_on: "2026-01-01T00:00:00Z" },
      { id: 2, updated_on: "2026-02-01T00:00:00Z" },
      { id: 3, updated_on: "2026-03-01T00:00:00Z" },
    ];

    expect(rankPendingReviewPRs(prs, 2).map((pr) => pr.id)).toEqual([3, 2]);
  });

  it("does not mutate the input array", () => {
    const prs = [
      { id: 1, updated_on: "2026-01-01T00:00:00Z" },
      { id: 2, updated_on: "2026-02-01T00:00:00Z" },
    ];
    rankPendingReviewPRs(prs, 1);
    expect(prs.map((pr) => pr.id)).toEqual([1, 2]);
  });

  it("puts entries with unusable timestamps last", () => {
    const prs = [
      { id: 1, updated_on: "not-a-date" },
      { id: 2, updated_on: "2026-02-01T00:00:00Z" },
      { id: 3 },
    ];
    expect(rankPendingReviewPRs(prs, 3).map((pr) => pr.id)).toEqual([2, 1, 3]);
  });
});
