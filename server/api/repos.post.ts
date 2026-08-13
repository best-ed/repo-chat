import { JobStatus } from '@prisma/client'
import { waitUntil } from '@vercel/functions'

import { prisma } from '../utils/prisma'
import { IngestError, parseRepoUrl } from '../utils/ingest/github'
import { isInFlight, isStaleIngest } from '../utils/ingest/state'
import { claimIngestSlot, holdIngestSlot, releaseIngestSlot } from '../utils/ingest/runner'

const BUSY_MESSAGE =
  'Another repository is currently being indexed — please try again in a moment.'

/**
 * Records a job as failed. Used from the fire-and-forget path, where there is no
 * request left to throw into, so a write that fails has nowhere to go.
 */
async function failJob(jobId: string, error: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.FAILED, error }
  }).catch(() => {})
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ url?: string }>(event)

  let ref
  try {
    ref = parseRepoUrl(body?.url ?? '')
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof IngestError ? error.message : 'Invalid repository URL.'
    })
  }

  const repo = await prisma.repo.upsert({
    where: { url: ref.url },
    create: { url: ref.url, owner: ref.owner, name: ref.name },
    update: {},
    include: { job: true }
  })

  // Job.repoId is unique, so a repo has exactly one job for its lifetime.
  // Re-posting a URL joins a run that is still in flight, and otherwise restarts
  // it — including a STAGED job, which is at rest rather than progressing.
  //
  // A job that stopped progressing long ago is not in flight, whatever its
  // status says: whatever was running it is gone, and nothing will ever move it
  // again. Joining it would wedge the URL forever, so it is restarted instead.
  // This is checked here rather than swept in the background because the wedge
  // only matters to someone asking for that repository, and this is where they
  // ask.
  if (repo.job && isInFlight(repo.job.status)) {
    if (!isStaleIngest(repo.job.updatedAt)) {
      return { jobId: repo.job.id, repoId: repo.id, status: repo.job.status, reused: true }
    }
    // Recovering from a crash leaves no other trace, and a repository quietly
    // reindexing itself is worth being able to see afterwards.
    console.warn(
      `[ingest] reclaiming ${ref.url}: job stuck at ${repo.job.status} since ` +
      `${repo.job.updatedAt.toISOString()}`
    )
  }

  // Claimed before the job row is touched. An ingest that cannot start must not
  // leave anything behind — least of all a repository that was already indexed,
  // whose job would otherwise be reset to QUEUED and then failed for a collision
  // that has nothing to do with it.
  if (!claimIngestSlot()) {
    throw createError({ statusCode: 409, statusMessage: BUSY_MESSAGE })
  }

  let job
  try {
    job = repo.job
      ? await prisma.job.update({
          where: { id: repo.job.id },
          data: { status: JobStatus.QUEUED, error: null, progress: 0, total: 0 }
        })
      : await prisma.job.create({
          data: { repoId: repo.id, status: JobStatus.QUEUED }
        })
  } catch (error) {
    releaseIngestSlot()
    throw error
  }

  const jobId = job.id

  // Deliberately not awaited: the caller gets a job id now and polls for the
  // rest. Every way this can end has to leave the job in a terminal state,
  // because a job nobody is running still reads as in-flight to the poller.
  const ingestion = holdIngestSlot(
    runTask('ingest', { payload: { jobId, repoId: repo.id, url: ref.url } })
      .then(async () => {
        // The task sets its own terminal status. Finding the job still QUEUED
        // means the run never reached it — the payload was dropped rather than
        // executed — and leaving it there is the stranding this guards against.
        const current = await prisma.job.findUnique({
          where: { id: jobId },
          select: { status: true }
        })
        if (current?.status === JobStatus.QUEUED) {
          await failJob(jobId, 'Indexing never started. Please try again.')
        }
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        await failJob(jobId, `Indexing could not be started: ${message}`)
      })
  )

  // Without this, a serverless runtime freezes the instance as soon as the
  // response is sent and the in-flight ingestion dies partway through. Outside a
  // Vercel request context this is a no-op, so local behaviour is unchanged.
  //
  // Ingestion is now bounded by the function's timeout rather than running
  // unbounded. That is acceptable at the 500-file / 5 MB cap; a larger cap would
  // need a queue and a worker instead.
  waitUntil(ingestion)

  setResponseStatus(event, 202)
  return { jobId: job.id, repoId: repo.id, status: job.status, reused: false }
})
