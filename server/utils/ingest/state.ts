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
 * Coarse stage name for API consumers. Derived from the status rather than
 * standing in for it — STAGED is a real status now, not a CLONING job with
 * progress === total.
 */
export function stageOf(status: JobStatus): string {
  return status.toLowerCase()
}
