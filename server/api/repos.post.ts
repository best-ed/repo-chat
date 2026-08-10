import { JobStatus } from '@prisma/client'

import { prisma } from '../utils/prisma'
import { IngestError, parseRepoUrl } from '../utils/ingest/github'

/** Statuses from which a job is still expected to make progress on its own. */
const ACTIVE_STATUSES: JobStatus[] = [
  JobStatus.QUEUED,
  JobStatus.CLONING,
  JobStatus.CHUNKING,
  JobStatus.EMBEDDING
]

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
  // Re-posting a URL either joins the run in flight or restarts a finished one.
  if (repo.job && ACTIVE_STATUSES.includes(repo.job.status)) {
    return { jobId: repo.job.id, repoId: repo.id, status: repo.job.status, reused: true }
  }

  const job = repo.job
    ? await prisma.job.update({
        where: { id: repo.job.id },
        data: { status: JobStatus.QUEUED, error: null, progress: 0, total: 0 }
      })
    : await prisma.job.create({
        data: { repoId: repo.id, status: JobStatus.QUEUED }
      })

  // Deliberately not awaited: the caller gets a job id now and polls for the
  // rest. The task owns its own error handling and never rejects.
  runTask('ingest', { payload: { jobId: job.id, repoId: repo.id, url: ref.url } })
    .catch(() => {})

  setResponseStatus(event, 202)
  return { jobId: job.id, repoId: repo.id, status: job.status, reused: false }
})
