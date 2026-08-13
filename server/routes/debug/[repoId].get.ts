import { prisma } from '../../utils/prisma'

/**
 * Chunk content is a join of lines, so it never carries a terminating newline —
 * every \n in it separates two real lines. `splitLines` must not be used here:
 * it strips a trailing empty line, which is right for a source file but wrong
 * for a chunk that legitimately ends on a blank line.
 */
function chunkLines(content: string): string[] {
  return content.split('\n')
}

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

  // Chunks the embedder refused. Ingestion skips these rather than failing the
  // whole repository, so they are the difference between what was chunked and
  // what can actually be found — worth stating outright, not inferring from a
  // count. Raw SQL: an `Unsupported` column cannot be filtered through the
  // generated client.
  const skipped = await prisma.$queryRaw<Array<{ path: string, startLine: number, endLine: number }>>`
    SELECT path, "startLine", "endLine"
    FROM "Chunk"
    WHERE "repoId" = ${repoId} AND embedding IS NULL
    ORDER BY path ASC, "startLine" ASC
  `
  const skippedKeys = new Set(skipped.map((c) => `${c.path}:${c.startLine}`))

  const lines: string[] = [
    `repo      ${repo.url}`,
    `commit    ${repo.commitSha ?? '(none)'}`,
    `status    ${repo.job?.status ?? '(no job)'}`,
    `files     ${repo.fileCount}`,
    `bytes     ${repo.byteCount}`,
    `chunks    ${chunks.length}`,
    `skipped   ${skipped.length}${skipped.length > 0 ? ' (no embedding — not searchable)' : ''}`,
    ''
  ]

  if (skipped.length > 0) {
    lines.push('The following chunks could not be embedded and cannot be retrieved:')
    for (const c of skipped) lines.push(`  ${c.path}:${c.startLine}-${c.endLine}`)
    lines.push('')
  }

  let currentPath: string | null = null
  for (const chunk of chunks) {
    if (chunk.path !== currentPath) {
      currentPath = chunk.path
      const forFile = chunks.filter((c) => c.path === currentPath)
      lines.push('='.repeat(78), `FILE ${chunk.path}  (${forFile.length} chunk(s))`, '='.repeat(78), '')
    }

    const span = chunk.endLine - chunk.startLine + 1
    const actual = chunkLines(chunk.content).length
    // A mismatch here means the range and the content disagree — the exact
    // failure this route exists to make visible.
    const flag = actual === span ? '' : `  <-- MISMATCH: content has ${actual} lines`
    const mark = skippedKeys.has(`${chunk.path}:${chunk.startLine}`) ? '  <-- SKIPPED: no embedding' : ''
    lines.push(`--- ${chunk.path} ${chunk.startLine}-${chunk.endLine} (${span} lines)${flag}${mark} ---`)

    const body = chunkLines(chunk.content)
    body.forEach((line, i) => lines.push(`${String(chunk.startLine + i).padStart(6)} | ${line}`))
    lines.push('')
  }

  if (chunks.length === 0) lines.push('(no chunks — has this repo been ingested?)')

  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return lines.join('\n')
})
