/**
 * Every `merge_strategy` value the Bitbucket Cloud merge endpoint accepts
 * (pullrequest_merge_parameters in the official OpenAPI spec). Merge queues
 * only take `merge_commit`, `squash` and `rebase_merge`.
 */
export const MERGE_STRATEGIES = [
  "merge_commit",
  "squash",
  "fast_forward",
  "squash_fast_forward",
  "rebase_fast_forward",
  "rebase_merge",
] as const;

export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

/**
 * Normalize a caller-supplied merge strategy to what Bitbucket accepts.
 *
 * The Bitbucket Cloud merge endpoint validates `merge_strategy` against the
 * underscore spellings in MERGE_STRATEGIES. This server used to
 * advertise the hyphenated spellings in its tool schema and passed them through
 * untouched, so every merge with an explicit strategy came back
 * `400 ... "merge-commit" is not one of the available choices`.
 *
 * Hyphenated forms are still accepted here — MCP clients cache tool schemas, so
 * callers may keep sending the old spelling for a while — but anything else is
 * rejected instead of being forwarded to Bitbucket.
 */
export function normalizeMergeStrategy(
  strategy: string | undefined
): MergeStrategy | undefined {
  if (strategy === undefined || strategy === null || strategy === "") {
    return undefined;
  }

  const normalized = String(strategy).trim().toLowerCase().replace(/-/g, "_");

  if (!(MERGE_STRATEGIES as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid merge strategy "${strategy}". Valid values: ${MERGE_STRATEGIES.join(
        ", "
      )}.`
    );
  }

  return normalized as MergeStrategy;
}
