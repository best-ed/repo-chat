/**
 * Splitting strategy sits behind one interface so alternatives — heuristic,
 * language-aware, parser-based — can replace it without touching the caller.
 * Only the line-window strategy exists today, on purpose: look at its output in
 * /debug before deciding whether anything smarter is warranted.
 */

/** Lines per chunk. */
export const WINDOW_LINES = 60

/**
 * Lines each chunk shares with the previous one. Overlap means a function
 * straddling a window boundary still appears whole in one of the two windows.
 */
export const OVERLAP_LINES = 10

export interface ChunkInput {
  path: string
  /** 1-based, inclusive. */
  startLine: number
  /** 1-based, inclusive. */
  endLine: number
  /** Exactly lines startLine..endLine, joined with \n. */
  content: string
}

export interface Splitter {
  chunk(path: string, content: string): ChunkInput[]
}

/**
 * Splits a file into lines the way the chunker counts them.
 *
 * A trailing newline terminates the last line rather than starting an empty
 * one, so "a\nb\n" is two lines, not three. Anything comparing chunk content
 * back to a source file has to split it the same way or it will disagree by one
 * line on every file that ends in a newline.
 */
export function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function createLineWindowSplitter(
  windowLines: number = WINDOW_LINES,
  overlapLines: number = OVERLAP_LINES
): Splitter {
  if (overlapLines >= windowLines) {
    throw new Error('Overlap must be smaller than the window, or chunking cannot advance.')
  }
  const stride = windowLines - overlapLines

  return {
    chunk(path: string, content: string): ChunkInput[] {
      // A file with nothing but whitespace carries no information; emitting a
      // chunk of blank lines would just be noise to retrieve against later.
      if (content.trim() === '') return []

      const lines = splitLines(content)
      if (lines.length === 0) return []

      const chunks: ChunkInput[] = []
      let start = 0

      for (;;) {
        const end = Math.min(start + windowLines, lines.length)

        chunks.push({
          path,
          startLine: start + 1,
          endLine: end,
          content: lines.slice(start, end).join('\n')
        })

        // Stop once a window reaches the end of the file; another stride would
        // only produce a chunk already contained in this one.
        if (end >= lines.length) break
        start += stride
      }

      return chunks
    }
  }
}
