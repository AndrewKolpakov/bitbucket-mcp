# Changelog

## Unreleased

- Fixed `getPullRequestDiffStat` failing with `404 You may not have access to this repository` on repositories the caller can read. Bitbucket `302`s that endpoint onto `/repositories/{workspace}/{repo_slug}/diffstat/{revspec}`, and credentials passed through axios's `auth` option are not replayed across a redirect. They are now sent as an `Authorization` header (`src/auth.ts`), which fixes every redirecting endpoint. Also declared the pagination arguments its handler already accepted.
- Made `maxItems`/`limit` a real cap on the items returned instead of only a page-following stop condition: a budget smaller than one page now shrinks the requested `pagelen`, and a page that still overshoots is trimmed with `truncated: true` plus a `warning` that `next` resumes after the trimmed items. `getPullRequests` with `pagelen: 100, maxItems: 3` used to return 50 items.
- Fixed `describeError` recursing into itself for non-Axios errors, which overflowed the stack instead of reporting the failure.
- Added a shared Bitbucket Cloud pagination helper and applied it across all list-style MCP tools so `pagelen`, `page`, and `all` arguments respect Bitbucket limits and `next` links (#37).
- Updated tool schemas, README documentation, and logging to describe the new pagination controls and to highlight the 1,000-item safety cap for `all=true`.
- Added Jest tests covering the pagination helper, including explicit `pagelen` requests, maximum page sizing, and automatic traversal of `next` links.
