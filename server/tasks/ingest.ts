import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { JobStatus } from '@prisma/client'

import { prisma } from '../utils/prisma'
import { IngestError, openTarball, parseRepoUrl, resolveRepo } from '../utils/ingest/github'
import { createStagingDir, removeStagingDir, stageTarball, type StagedRepo } from '../utils/ingest/stage'
import { createLineWindowSplitter } from '../utils/ingest/splitter'
import {
  EMBEDDING_BATCH_SIZE,
  createEmbedder,
  toVectorLiteral
} from '../utils/ingest/embedder'

/** Rows per insert. Keeps a large repo well clear of statement parameter limits. */
const CHUNK_INSERT_BATCH = 250

/** How often to publish progress while chunking, in files. */
const PROGRESS_INTERVAL = 25

const splitter = createLineWindowSplitter()
const embedder = createEmbedder()

/**
 * Writes vectors for a batch of chunks in one statement.
 *
 * Chunk.embedding is `Unsupported` in the Prisma schema, so the generated client
 * cannot write it — this has to be raw SQL. Both the id and the vector literal
 * are bound parameters; nothing is concatenated into the statement except the
 * placeholder positions.
 */
async function writeEmbeddings(rows: Array<{ id: string, embedding: number[] }>): Promise<void> {
  if (rows.length === 0) return

  const tuples: string[] = []
  const params: string[] = []

  rows.forEach((row, i) => {
    tuples.push(`($${i * 2 + 1}::text, $${i * 2 + 2}::vector)`)
    params.push(row.id, toVectorLiteral(row.embedding))
  })

  const sql =
    `UPDATE "Chunk" AS c SET embedding = v.embedding ` +
    `FROM (VALUES ${tuples.join(', ')}) AS v(id, embedding) ` +
    `WHERE c.id = v.id`

  await prisma.$executeRawUnsafe(sql, ...params)
}

/**
 * Embeds every chunk of a repo as a passage and stores the vectors.
 *
 * Chunks are read with explicit columns: selecting the embedding column back
 * through the Prisma client fails to deserialize the pgvector type.
 */
async function embedRepoChunks(repoId: string, jobId: string): Promise<number> {
  const chunks = await prisma.chunk.findMany({
    where: { repoId },
    select: { id: true, path: true, startLine: true, endLine: true, content: true },
    orderBy: [{ path: 'asc' }, { startLine: 'asc' }]
  })

  await prisma.job.update({
    where: { id: jobId },
    data: { progress: 0, total: chunks.length }
  })

  let embedded = 0

  for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE)

    // One input type per request — never mix passages and queries in a batch.
    const vectors = await embedder.embed(batch.map((chunk) => chunk.content), 'passage')

    await writeEmbeddings(batch.map((chunk, i) => ({ id: chunk.id, embedding: vectors[i]! })))

    embedded += batch.length
    await prisma.job.update({ where: { id: jobId }, data: { progress: embedded } })
  }

  return embedded
}

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
 * The state machine is
 * QUEUED -> CLONING -> STAGED -> CHUNKING -> EMBEDDING -> READY | FAILED.
 * READY is terminal and means every chunk of the repo carries a vector.
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

      await prisma.job.update({
        where: { id: jobId },
        data: { status: JobStatus.EMBEDDING, progress: 0, total: chunkCount }
      })

      const embeddedCount = await embedRepoChunks(repoId, jobId)

      // READY means every chunk is searchable. A chunk left without a vector is
      // invisible to retrieval, so reaching READY with one is a silent hole.
      // Raw SQL because an `Unsupported` column cannot be filtered on through
      // the generated client.
      const [{ missing }] = await prisma.$queryRaw<Array<{ missing: number }>>`
        SELECT count(*)::int AS missing
        FROM "Chunk"
        WHERE "repoId" = ${repoId} AND embedding IS NULL
      `
      if (missing > 0) {
        throw new IngestError(`${missing} of ${chunkCount} chunks were left without an embedding.`)
      }

      await prisma.job.update({
        where: { id: jobId },
        data: { status: JobStatus.READY, progress: embeddedCount, total: chunkCount }
      })

      return {
        result: 'ready',
        fileCount: staged.fileCount,
        byteCount: staged.byteCount,
        chunkCount,
        embeddedCount
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
