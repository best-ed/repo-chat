export interface Citation {
  path: string
  startLine: number
  endLine: number
}

/** Escapes a repo path for use inside a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Which of the retrieved chunks the answer actually referenced.
 *
 * Retrieval hands the model more chunks than it needs — anything under the
 * distance threshold — so listing all of them as sources overstates where the
 * answer came from. This narrows the displayed set to chunks the text points at.
 *
 * The retrieved set is the ceiling, not a starting point: the search runs from
 * retrieved chunks outward, so a reference the model invents cannot enter the
 * result. A model citing a file it was never given is a bug, and the correct
 * handling is to drop it silently rather than render it.
 *
 * References are matched by containment, not equality, because the model
 * legitimately narrows: given `index.js:1-8` it may cite `index.js:2-4` for a
 * specific claim, and `index.d.ts:35` with no range at all.
 */
export function usedCitations(answer: string, retrieved: Citation[]): Citation[] {
  if (!answer) return []

  return retrieved.filter((citation) => {
    // `path:12-40`, or `path:35` for a single line. The lookbehind stops
    // `test.js` from matching inside `src/mytest.js`.
    const pattern = new RegExp(
      `(?<![\\w./-])${escapeForRegExp(citation.path)}:(\\d+)(?:\\s*[-–]\\s*(\\d+))?`,
      'g'
    )

    for (const match of answer.matchAll(pattern)) {
      const start = Number(match[1])
      const end = match[2] === undefined ? start : Number(match[2])
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue

      // Any overlap with the chunk counts as referencing it.
      if (start <= citation.endLine && end >= citation.startLine) return true
    }

    return false
  })
}
