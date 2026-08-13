import { JobStatus } from '@prisma/client'

/** Statuses from which a job is still expected to advance on its own. */
const IN_FLIGHT: ReadonlySet<JobStatus> = new Set([
  JobStatus.QUEUED,
  JobStatus.CLONING,
  JobStatus.CHUNKING,
  JobStatus.EMBEDDING
])

export function isInFlight(status: JobStatus): boolean {
  return IN_FLIGHT.has(status)
}

/**
 * How long an in-flight job may go without progressing before it is presumed
 * dead and may be restarted.
 *
 * A process that dies mid-ingest — a killed dev server, a serverless function
 * hitting its timeout — leaves the job in a state it can never leave on its own.
 * Nothing is running to fail it, and because it still reads as in-flight, a
 * re-post joins the corpse instead of starting over. That wedges the URL
 * permanently.
 *
 * The value has to sit above the longest gap a healthy ingest can leave between
 * writes, because reclaiming a job that is merely slow would start a second
 * ingest against the same repository. Every status change advances updatedAt,
 * chunking advances it every 25 files, and embedding advances it after every
 * batch. The two real gaps are the tarball download, which no job write spans,
 * and a single embedding batch, which can stretch to minutes when a batch fails
 * and is halved down to isolate the cause. Both are bounded by the 500-file /
 * 5 MB cap; neither plausibly approaches half an hour.
 *
 * Thirty minutes is therefore many times the worst gap while still letting a
 * genuinely wedged URL recover the same session. On Vercel the wedge happens
 * within the function timeout — minutes, not hours — so waiting longer would
 * only extend how long a user is locked out of a repository.
 */
export const STALE_INGEST_MINUTES = 30

/**
 * Whether an in-flight job has stopped progressing for long enough to be
 * treated as dead. A frozen updatedAt is the signal: a live ingest keeps
 * writing, so only one that is no longer running can stand still.
 */
export function isStaleIngest(updatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - updatedAt.getTime() > STALE_INGEST_MINUTES * 60_000
}

/**
 * Coarse stage name for API consumers. Derived from the status rather than
 * standing in for it — STAGED is a real status now, not a CLONING job with
 * progress === total.
 */
export function stageOf(status: JobStatus): string {
  return status.toLowerCase()
}
