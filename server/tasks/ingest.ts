import { JobStatus } from '@prisma/client'

import { prisma } from '../utils/prisma'
import { IngestError, openTarball, parseRepoUrl, resolveRepo } from '../utils/ingest/github'
import { createStagingDir, removeStagingDir, stageTarball } from '../utils/ingest/stage'

export interface IngestPayload {
  jobId: string
  repoId: string
  url: string
}

/**
 * Ingestion runs here rather than in the request handler so that POST /api/repos
 * can return a job id immediately instead of blocking on a download.
 *
 * The state machine for this phase is QUEUED -> CLONING -> STAGED | FAILED.
 * It deliberately stops at STAGED: nothing chunks yet, and a job sitting in a
 * status it isn't doing would misreport progress. Phase 3 drives STAGED ->
 * CHUNKING from here.
 */
export default defineTask({
  meta: {
    name: 'ingest',
    description: 'Download a public GitHub repository and stage its indexable files.'
  },

  async run({ payload }) {
    const { jobId, repoId, url } = payload as unknown as IngestPayload
    let stagingDir: string | undefined

    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: JobStatus.CLONING, error: null, progress: 0, total: 0 }
      })

      // Counts must describe this run only. Left alone, a re-ingest that fails
      // would sit next to totals from an earlier successful run and read as if
      // those files were still staged.
      await prisma.repo.update({
        where: { id: repoId },
        data: { fileCount: 0, byteCount: 0 }
      })

      const resolved = await resolveRepo(parseRepoUrl(url))

      // Record the commit before downloading, so a failure still leaves behind
      // which revision was attempted.
      await prisma.repo.update({
        where: { id: repoId },
        data: { commitSha: resolved.commitSha }
      })

      stagingDir = await createStagingDir()
      const staged = await stageTarball(await openTarball(resolved), stagingDir)

      if (staged.fileCount === 0) {
        throw new IngestError('No indexable files found in this repository.')
      }

      await prisma.repo.update({
        where: { id: repoId },
        data: { fileCount: staged.fileCount, byteCount: staged.byteCount }
      })

      // Files are on disk under stagingDir and the manifest is in hand.
      // Chunking will slot in here, before the finally block reclaims the dir.
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: JobStatus.STAGED,
          progress: staged.fileCount,
          total: staged.fileCount
        }
      })

      return { result: 'staged', fileCount: staged.fileCount, byteCount: staged.byteCount }
    } catch (error) {
      const message = error instanceof IngestError
        ? error.message
        : `Ingestion failed: ${error instanceof Error ? error.message : String(error)}`

      // A repo that broke the caps must never look complete. Counts stay at
      // whatever was last written and the job is explicitly FAILED.
      await prisma.job.update({
        where: { id: jobId },
        data: { status: JobStatus.FAILED, error: message }
      }).catch(() => {
        // Nothing useful left to do if even the failure write fails; swallowing
        // keeps the task from rejecting into a dropped promise.
      })

      return { result: 'failed', error: message }
    } finally {
      if (stagingDir) await removeStagingDir(stagingDir).catch(() => {})
    }
  }
})
