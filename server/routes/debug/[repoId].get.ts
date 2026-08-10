import { prisma } from '../../utils/prisma'
import { splitLines } from '../../utils/ingest/splitter'

/**
 * Inspection gate for chunk quality: every chunk for a repo, grouped by file and
 * ordered by start line, so boundaries and line ranges can be eyeballed before
 * anything is spent on embedding them.
 *
 * Plain text on purpose — chunk content is arbitrary source code, and rendering
 * it as HTML would mean escaping it correctly for no benefit.
 */
export default defineEventHandler(async (event) => {
  const repoId = getRouterParam(event, 'repoId')
  if (!repoId) throw createError({ statusCode: 400, statusMessage: 'Missing repo id.' })

  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { url: true, commitSha: true, fileCount: true, byteCount: true, job: { select: { status: true } } }
  })
  if (!repo) throw createError({ statusCode: 404, statusMessage: 'Repo not found.' })

  // Explicit columns: selecting the embedding column would fail to deserialize.
  const chunks = await prisma.chunk.findMany({
    where: { repoId },
    select: { path: true, startLine: true, endLine: true, content: true },
    orderBy: [{ path: 'asc' }, { startLine: 'asc' }]
  })

  const lines: string[] = [
    `repo      ${repo.url}`,
    `commit    ${repo.commitSha ?? '(none)'}`,
    `status    ${repo.job?.status ?? '(no job)'}`,
    `files     ${repo.fileCount}`,
    `bytes     ${repo.byteCount}`,
    `chunks    ${chunks.length}`,
    ''
  ]

  let currentPath: string | null = null
  for (const chunk of chunks) {
    if (chunk.path !== currentPath) {
      currentPath = chunk.path
      const forFile = chunks.filter((c) => c.path === currentPath)
      lines.push('='.repeat(78), `FILE ${chunk.path}  (${forFile.length} chunk(s))`, '='.repeat(78), '')
    }

    const span = chunk.endLine - chunk.startLine + 1
    const actual = splitLines(chunk.content).length
    // A mismatch here means the range and the content disagree — the exact
    // failure this route exists to make visible.
    const flag = actual === span ? '' : `  <-- MISMATCH: content has ${actual} lines`
    lines.push(`--- ${chunk.path} ${chunk.startLine}-${chunk.endLine} (${span} lines)${flag} ---`)

    const body = splitLines(chunk.content)
    body.forEach((line, i) => lines.push(`${String(chunk.startLine + i).padStart(6)} | ${line}`))
    lines.push('')
  }

  if (chunks.length === 0) lines.push('(no chunks — has this repo been ingested?)')

  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return lines.join('\n')
})
