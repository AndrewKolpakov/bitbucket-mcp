import type { MergeStrategy } from "./merge-strategy.js";

export type ReviewerRef = {
  uuid?: string;
  account_id?: string;
};

export interface AccountLike {
  uuid?: string;
  account_id?: string;
  [k: string]: unknown;
}

const BARE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Turn a "{uuid}", bare uuid or Atlassian account id into an API reference. */
export function toReviewerRef(id: string): ReviewerRef {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!trimmed) {
    throw new Error("Empty reviewer id");
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return { uuid: trimmed };
  }
  if (BARE_UUID.test(trimmed)) {
    return { uuid: `{${trimmed}}` };
  }
  return { account_id: trimmed };
}

const stripBraces = (s: string) => s.replace(/^\{/, "").replace(/\}$/, "");

export function sameReviewer(a: AccountLike, b: AccountLike): boolean {
  if (a.uuid && b.uuid) {
    return (
      stripBraces(a.uuid).toLowerCase() === stripBraces(b.uuid).toLowerCase()
    );
  }
  if (a.account_id && b.account_id) {
    return a.account_id === b.account_id;
  }
  return false;
}

function dedupe(refs: ReviewerRef[]): ReviewerRef[] {
  const out: ReviewerRef[] = [];
  for (const r of refs) {
    if (!out.some((o) => sameReviewer(o, r))) out.push(r);
  }
  return out;
}

export function computeReviewers(
  current: AccountLike[],
  change: { set?: string[]; add?: string[]; remove?: string[] }
): ReviewerRef[] | undefined {
  const { set, add, remove } = change;
  if (set === undefined && add === undefined && remove === undefined) {
    return undefined;
  }
  if (set !== undefined && (add !== undefined || remove !== undefined)) {
    throw new Error(
      "reviewers (full replacement) and addReviewers/removeReviewers cannot be combined; use either reviewers, or addReviewers/removeReviewers"
    );
  }
  if (set !== undefined) {
    return dedupe(set.map(toReviewerRef));
  }

  const removeRefs = (remove ?? []).map(toReviewerRef);
  const keptAccounts: AccountLike[] = [];
  const kept: ReviewerRef[] = [];
  for (const account of current ?? []) {
    if (removeRefs.some((r) => sameReviewer(account, r))) continue;
    if (account.uuid) kept.push({ uuid: account.uuid });
    else if (account.account_id) kept.push({ account_id: account.account_id });
    else continue;
    keptAccounts.push(account);
  }
  // Compare added refs against the full current accounts (which may carry both
  // uuid and account_id), not only the stripped single-key refs.
  const out: ReviewerRef[] = [...kept];
  for (const ref of (add ?? []).map(toReviewerRef)) {
    if (keptAccounts.some((a) => sameReviewer(a, ref))) continue;
    if (out.some((o) => sameReviewer(o, ref))) continue;
    out.push(ref);
  }
  return dedupe(out);
}

/** Raw removal ids (trimmed) that match no current reviewer. */
export function findUnmatchedRemovals(
  current: AccountLike[],
  remove: string[] | undefined
): string[] {
  const out: string[] = [];
  for (const raw of remove ?? []) {
    const ref = toReviewerRef(raw);
    if (!(current ?? []).some((a) => sameReviewer(a, ref))) {
      out.push(raw.trim());
    }
  }
  return out;
}

export function buildPullRequestUpdate(input: {
  title?: string;
  description?: string;
  destinationBranch?: string;
  closeSourceBranch?: boolean;
  reviewers?: ReviewerRef[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.destinationBranch !== undefined) {
    body.destination = { branch: { name: input.destinationBranch } };
  }
  if (input.closeSourceBranch !== undefined) {
    body.close_source_branch = input.closeSourceBranch;
  }
  if (input.reviewers !== undefined) body.reviewers = input.reviewers;
  if (Object.keys(body).length === 0) {
    throw new Error(
      "Nothing to update: pass at least one of title, description, destinationBranch, closeSourceBranch, reviewers, addReviewers, removeReviewers"
    );
  }
  return body;
}

export function buildMergeBody(input: {
  message?: string;
  strategy?: MergeStrategy;
  closeSourceBranch?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof input.message === "string" && input.message !== "") {
    body.message = input.message;
  }
  if (input.strategy !== undefined) body.merge_strategy = input.strategy;
  if (input.closeSourceBranch !== undefined) {
    body.close_source_branch = input.closeSourceBranch;
  }
  return body;
}

export function parseMergeTaskId(
  location: string | undefined | null
): string | undefined {
  if (!location) return undefined;
  const m = /\/merge\/task-status\/([^/?#]+)/.exec(location);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export const PULL_REQUEST_STATES = [
  "OPEN",
  "MERGED",
  "DECLINED",
  "SUPERSEDED",
] as const;

export function buildStateQuery(states: string | string[] | undefined): string {
  if (states === undefined || states === null) return "";
  const list = Array.isArray(states) ? states : [states];
  const seen: string[] = [];
  for (const raw of list) {
    const s = String(raw).trim().toUpperCase();
    if (!s) continue;
    if (!(PULL_REQUEST_STATES as readonly string[]).includes(s)) {
      throw new Error(
        `Invalid pull request state "${raw}". Valid values: ${PULL_REQUEST_STATES.join(", ")}.`
      );
    }
    if (!seen.includes(s)) seen.push(s);
  }
  return seen.map((s) => `state=${s}`).join("&");
}
