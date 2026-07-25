/**
 * Pure helpers behind `getPendingReviewPRs`, split out so the selection rules
 * can be tested without standing up the MCP server.
 */

export interface RepositoryLike {
  slug?: string;
  name?: string;
  full_name?: string;
}

export interface ParticipantLike {
  user?: { nickname?: string };
  role?: string;
  approved?: boolean;
}

export interface PullRequestLike {
  id?: number;
  updated_on?: string;
  participants?: ParticipantLike[];
}

/**
 * Repository path segment for API URLs.
 *
 * This used to read `repo.name`, which is the display name: `AI-Chat` for a
 * repository whose slug is `ai-chat`, and anything at all for one named
 * "My Repo (old)". Those requests 404'd and the error was swallowed, so the
 * repository simply looked like it had no review requests.
 */
export function repositorySlug(repo: RepositoryLike): string | undefined {
  if (repo.slug) return repo.slug;
  if (repo.full_name && repo.full_name.includes("/")) {
    return repo.full_name.split("/").pop();
  }
  return repo.name;
}

/** True when `nickname` is a reviewer on `pr` who has not approved yet. */
export function isPendingReviewer(
  pr: PullRequestLike,
  nickname: string
): boolean {
  if (!Array.isArray(pr.participants)) return false;
  return pr.participants.some(
    (participant) =>
      participant.user?.nickname === nickname &&
      participant.role === "REVIEWER" &&
      participant.approved === false
  );
}

/**
 * Most recently updated first, then cut to `limit`.
 *
 * The previous order was slice-then-sort, so the "top N by update time" was
 * really "N arbitrary PRs in repository-scan order, sorted among themselves".
 */
export function rankPendingReviewPRs<T extends PullRequestLike>(
  prs: T[],
  limit: number
): T[] {
  const timestamp = (pr: T) => {
    const parsed = Date.parse(pr.updated_on ?? "");
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return [...prs].sort((a, b) => timestamp(b) - timestamp(a)).slice(0, limit);
}
