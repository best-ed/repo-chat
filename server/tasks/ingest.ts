import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { JobStatus } from '@prisma/client'

import { prisma } from '../utils/prisma'
import { IngestError, openTarball, parseRepoUrl, resolveRepo } from '../utils/ingest/github'
import { createStagingDir, removeStagingDir, stageTarball, type StagedRepo } from '../utils/ingest/stage'
import { createLineWindowSplitter } from '../utils/ingest/splitter'

/** Rows per insert. Keeps a large repo well clear of statement parameter limits. */
const CHUNK_INSERT_BATCH = 250

/** How often to publish progress while chunking, in files. */
const PROGRESS_INTERVAL = 25

const splitter = createLineWindowSplitter()

/**
 * Splits every staged file and writes the chunks. Runs while the staging
 * directory still exists — the files are only on disk for the life of the task.
 */
async function chunkStagedFiles(repoId: string, jobId: string, staged: StagedRepo): Promise<number> {
  let pending: Array<{ repoId: string, path: string, startLine: number, endLine: number, content: string }> = []
  let written = 0
  let filesDone = 0

  const flush = async () => {
    if (pending.length === 0) return
    await prisma.chunk.createMany({ data: pending })
    written += pending.length
    pending = []
  }

  for (const file of staged.files) {
    const content = await readFile(path.join(staged.dir, file.path), 'utf8')

    for (const chunk of splitter.chunk(file.path, content)) {
      pending.push({ repoId, ...chunk })
      if (pending.length >= CHUNK_INSERT_BATCH) await flush()
    }

    filesDone++
    if (filesDone % PROGRESS_INTERVAL === 0) {
      await prisma.job.update({ where: { id: jobId }, data: { progress: filesDone } })
    }
  }

  await flush()
  await prisma.job.update({ where: { id: jobId }, data: { progress: filesDone } })
  return written
}

export interface IngestPayload {
  jobId: string
  repoId: string
  url: string
}

/**
 * Ingestion runs here rather than in the request handler so that POST /api/repos
 * can return a job id immediately instead of blocking on a download.
 *
 * The state machine is QUEUED -> CLONING -> STAGED -> CHUNKING | FAILED, and
 * rests at CHUNKING. Embedding picks it up from there; until it exists,
 * CHUNKING is where a finished ingest sits.
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

      // Counts and chunks must describe this run only. Left alone, a re-ingest
      // that fails would sit next to totals and chunks from an earlier
      // successful run and read as if that content were still current.
      await prisma.repo.update({
        where: { id: repoId },
        data: { fileCount: 0, byteCount: 0 }
      })
      await prisma.chunk.deleteMany({ where: { repoId } })

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
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: JobStatus.STAGED,
          progress: staged.fileCount,
          total: staged.fileCount
        }
      })

      // Chunking reads from the staging directory, so it has to finish before
      // the finally block reclaims it.
      await prisma.job.update({
        where: { id: jobId },
        data: { status: JobStatus.CHUNKING, progress: 0, total: staged.fileCount }
      })

      const chunkCount = await chunkStagedFiles(repoId, jobId, staged)

      return {
        result: 'chunked',
        fileCount: staged.fileCount,
        byteCount: staged.byteCount,
        chunkCount
      }
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
