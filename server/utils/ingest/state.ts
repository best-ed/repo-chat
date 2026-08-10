import { JobStatus } from '@prisma/client'

/**
 * The schema's JobStatus has no member for "cloned, not yet chunked", and the
 * schema is fixed. So a staged job rests in CLONING with progress === total,
 * and that pairing is the single definition of "staged" used everywhere.
 *
 * If a STAGED member is ever added to the enum, this is the only place that
 * needs to change.
 */
export function isStaged(status: JobStatus, progress: number, total: number): boolean {
  return status === JobStatus.CLONING && total > 0 && progress === total
}

const IN_FLIGHT: ReadonlySet<JobStatus> = new Set([
  JobStatus.QUEUED,
  JobStatus.CLONING,
  JobStatus.CHUNKING,
  JobStatus.EMBEDDING
])

/**
 * Whether a job is still expected to advance on its own. A staged job is at
 * rest despite its CLONING status — treating it as in-flight would make the
 * repo permanently un-reingestible.
 */
export function isInFlight(status: JobStatus, progress: number, total: number): boolean {
  if (isStaged(status, progress, total)) return false
  return IN_FLIGHT.has(status)
}

/** Coarse stage name for API consumers. */
export function stageOf(status: JobStatus, progress: number, total: number): string {
  return isStaged(status, progress, total) ? 'staged' : status.toLowerCase()
}
