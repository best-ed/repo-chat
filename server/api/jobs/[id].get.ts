import { prisma } from '../../utils/prisma'
import { stageOf } from '../../utils/ingest/state'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing job id.' })

  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      repo: {
        select: {
          id: true,
          url: true,
          owner: true,
          name: true,
          commitSha: true,
          fileCount: true,
          byteCount: true
        }
      }
    }
  })

  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found.' })

  return {
    jobId: job.id,
    status: job.status,
    stage: stageOf(job.status, job.progress, job.total),
    error: job.error,
    progress: job.progress,
    total: job.total,
    repo: job.repo,
    updatedAt: job.updatedAt
  }
})
