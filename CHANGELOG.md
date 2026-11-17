# Changelog

## Unreleased

- `mergePullRequest` accepts the remaining Bitbucket merge strategies: `squash_fast_forward`, `rebase_fast_forward` and `rebase_merge` (hyphenated aliases too). They were rejected with `InvalidParams` before.
- Added `requestChangesPullRequest` and `unrequestChangesPullRequest` (POST/DELETE `.../request-changes`).
- `updatePullRequest` now accepts `destinationBranch`, `closeSourceBranch`, and reviewer changes via `reviewers` (full replacement, `[]` clears), `addReviewers` and `removeReviewers` (ids as `{uuid}`, bare uuid or Atlassian account_id). Add/remove read the current reviewers first and always send the full list; a removal that matches no current reviewer is rejected instead of silently ignored. Invalid input returns `InvalidParams`.
- `mergePullRequest` now accepts `closeSourceBranch` and `async`; a `202` response is returned as `{ status: "PENDING", task_id, task_status_url }`. Added `getPullRequestMergeTaskStatus`.
- Added `getPullRequestsForCommit` (explicit `indexing: true` result when any page answers `202`, via the paginator's new opt-in `rejectAccepted`; descriptive error for `404`) and `getUserPullRequests` (pull requests authored by a user across a workspace, repeated `state` params).
- `createPullRequest` and `createDraftPullRequest` accept `closeSourceBranch` (default stays `true`).
- Added `src/pull-request-ops.ts` with the pure helpers behind these tools.
- Fixed `getPullRequestDiffStat` failing with `404 You may not have access to this repository` on repositories the caller can read. Bitbucket `302`s that endpoint onto `/repositories/{workspace}/{repo_slug}/diffstat/{revspec}`, and credentials passed through axios's `auth` option are not replayed across a redirect. They are now sent as an `Authorization` header (`src/auth.ts`), which fixes every redirecting endpoint. Also declared the pagination arguments its handler already accepted.
- Made `maxItems`/`limit` a real cap on the items returned instead of only a page-following stop condition: a budget smaller than one page now shrinks the requested `pagelen`, and a page that still overshoots is trimmed with `truncated: true` plus a `warning` that `next` resumes after the trimmed items. `getPullRequests` with `pagelen: 100, maxItems: 3` used to return 50 items.
- Fixed `describeError` recursing into itself for non-Axios errors, which overflowed the stack instead of reporting the failure.
- Added a shared Bitbucket Cloud pagination helper and applied it across all list-style MCP tools so `pagelen`, `page`, and `all` arguments respect Bitbucket limits and `next` links (#37).
- Updated tool schemas, README documentation, and logging to describe the new pagination controls and to highlight the 1,000-item safety cap for `all=true`.
- Added Jest tests covering the pagination helper, including explicit `pagelen` requests, maximum page sizing, and automatic traversal of `next` links.
