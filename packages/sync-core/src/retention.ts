export interface RetentionRevision {
  revisionId: string;
  committedAt: number;
}

export interface RetentionPolicy {
  hourly: number;
  daily: number;
  monthly: number;
}

export type RetentionTier = keyof RetentionPolicy;

export interface RetentionCheckpoint extends RetentionRevision {
  tier: RetentionTier;
  bucket: string;
}

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = Object.freeze({
  hourly: 24,
  daily: 30,
  monthly: 12,
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Selects deterministic checkpoints from a newest-to-oldest revision chain. */
export function selectRetentionCheckpoints(
  revisions: readonly RetentionRevision[],
  now: number,
  policy: Readonly<RetentionPolicy> = DEFAULT_RETENTION_POLICY,
): RetentionCheckpoint[] {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("current time must be a non-negative safe integer");
  for (const count of Object.values(policy)) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) throw new TypeError("retention count must be an integer from 0 to 10000");
  }
  const seenRevisions = new Set<string>();
  for (const revision of revisions) {
    if (!revision.revisionId) throw new TypeError("retention revision ID is required");
    if (seenRevisions.has(revision.revisionId)) throw new TypeError("duplicate revision ID in retention history");
    if (!Number.isSafeInteger(revision.committedAt) || revision.committedAt < 0) throw new TypeError("retention revision timestamp is invalid");
    seenRevisions.add(revision.revisionId);
  }

  return [
    ...selectFixedBuckets("hourly", revisions, now, policy.hourly, HOUR_MS, hourBucket),
    ...selectFixedBuckets("daily", revisions, now, policy.daily, DAY_MS, dayBucket),
    ...selectMonthlyBuckets(revisions, now, policy.monthly),
  ];
}

function selectFixedBuckets(
  tier: "hourly" | "daily",
  revisions: readonly RetentionRevision[],
  now: number,
  count: number,
  width: number,
  label: (value: number) => string,
): RetentionCheckpoint[] {
  if (count === 0) return [];
  const current = Math.floor(now / width);
  const minimum = current - count + 1;
  const selected = new Map<number, RetentionRevision>();
  for (const revision of revisions) {
    const bucket = Math.floor(Math.min(revision.committedAt, now) / width);
    if (bucket < minimum || bucket > current || selected.has(bucket)) continue;
    selected.set(bucket, revision);
  }
  return [...selected.entries()]
    .sort(([left], [right]) => right - left)
    .map(([bucket, revision]) => ({ tier, bucket: label(bucket * width), ...revision }));
}

function selectMonthlyBuckets(
  revisions: readonly RetentionRevision[],
  now: number,
  count: number,
): RetentionCheckpoint[] {
  if (count === 0) return [];
  const currentDate = new Date(now);
  const current = currentDate.getUTCFullYear() * 12 + currentDate.getUTCMonth();
  const minimum = current - count + 1;
  const selected = new Map<number, RetentionRevision>();
  for (const revision of revisions) {
    const date = new Date(Math.min(revision.committedAt, now));
    const bucket = date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (bucket < minimum || bucket > current || selected.has(bucket)) continue;
    selected.set(bucket, revision);
  }
  return [...selected.entries()]
    .sort(([left], [right]) => right - left)
    .map(([bucket, revision]) => ({ tier: "monthly", bucket: monthBucket(bucket), ...revision }));
}

function hourBucket(value: number): string {
  return new Date(value).toISOString().slice(0, 13);
}

function dayBucket(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function monthBucket(value: number): string {
  const year = Math.floor(value / 12);
  const month = value % 12;
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
}
