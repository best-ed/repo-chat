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

/**
 * Token ceiling for one chunk, below the embedder's per-input limit.
 *
 * Sixty lines is a line count, not a size, so one dense window can carry far
 * more text than a hundred ordinary ones. Past the provider's per-input limit
 * the request fails outright, and before this cap existed a single such window
 * failed the entire repository's ingest.
 *
 * The limit was measured by binary search against the configured provider, on
 * real text rather than repeated characters — repeated characters tokenize far
 * better than language does:
 *
 *   ASCII source code   ~5135 characters embedded, more did not
 *   CJK prose            ~488 characters embedded, more did not
 *
 * Both land near 1465 on the estimate below, from opposite ends of the
 * character-cost range, which is what makes it usable as a scale. It is only a
 * scale though: markdown full of links tokenizes far worse than the estimate
 * suggests, and observed failures range from about 1600 upward depending on
 * content. 1000 sits under the lowest of those with room to spare, which is the
 * point — an estimate this rough has to be spent on margin rather than
 * throughput. Re-measure after an embedding provider or model change.
 */
export const MAX_CHUNK_TOKENS = 1000

/**
 * Characters per token for ASCII text. Real code averages closer to 4; 3.5
 * biases every estimate upward, which is the safe direction for a cap.
 */
const ASCII_CHARS_PER_TOKEN = 3.5

/**
 * Non-ASCII text is priced at its UTF-8 byte count.
 *
 * A code-specialized tokenizer has little vocabulary for other scripts, so it
 * falls back to bytes and merges almost nothing: a CJK character costs about
 * three tokens, which is exactly its byte length. Pricing by bytes extends that
 * to scripts that were never measured — accented Latin at 2, emoji at 4 — and
 * errs high for the ones that do merge.
 */
function textCost(text: string): { ascii: number, wide: number } {
  let ascii = 0
  let wide = 0

  // Iterating a string yields code points, so a surrogate pair counts once.
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (codePoint < 0x80) ascii++
    else if (codePoint < 0x800) wide += 2
    else if (codePoint < 0x10000) wide += 3
    else wide += 4
  }

  return { ascii, wide }
}

function tokensFor(ascii: number, wide: number): number {
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + wide
}

/**
 * Approximate token count. Deliberately an estimate: a real tokenizer would mean
 * shipping the provider's vocabulary, and the cap carries enough headroom that
 * an approximation is sufficient.
 */
export function estimateTokens(text: string): number {
  const { ascii, wide } = textCost(text)
  return tokensFor(ascii, wide)
}

/**
 * Splits the half-open line range [from, to) into consecutive ranges that each
 * fit the token budget.
 *
 * The pieces tile: contiguous, no gaps, no overlap between them. Overlap belongs
 * to primary windows, and repeating it here would multiply chunks on exactly the
 * densest files.
 *
 * Splits land on line boundaries only, so every piece stays byte-exact for the
 * lines it claims — the guarantee citations resolve against. One line longer
 * than the budget therefore cannot be divided; it is emitted alone and over
 * budget. The estimate is conservative so it may still embed, and if it does
 * not, embedding skips that one chunk rather than failing the repository.
 */
function tokenBoundedRanges(
  lines: string[],
  from: number,
  to: number,
  maxTokens: number
): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let start = from
  let ascii = 0
  let wide = 0

  for (let i = from; i < to; i++) {
    const cost = textCost(lines[i]!)
    // The newline this line is joined with, once it is not the first.
    const separator = i > start ? 1 : 0

    if (i > start && tokensFor(ascii + cost.ascii + separator, wide + cost.wide) > maxTokens) {
      ranges.push([start, i])
      start = i
      ascii = cost.ascii
      wide = cost.wide
      continue
    }

    ascii += cost.ascii + separator
    wide += cost.wide
  }

  if (start < to) ranges.push([start, to])
  return ranges
}

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
  overlapLines: number = OVERLAP_LINES,
  maxTokens: number = MAX_CHUNK_TOKENS
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
        const content = lines.slice(start, end).join('\n')

        // Most windows fit and are emitted whole. Only a window dense enough to
        // risk the embedder's per-input limit is divided further.
        if (estimateTokens(content) <= maxTokens) {
          chunks.push({ path, startLine: start + 1, endLine: end, content })
        } else {
          for (const [from, to] of tokenBoundedRanges(lines, start, end, maxTokens)) {
            chunks.push({
              path,
              startLine: from + 1,
              endLine: to,
              content: lines.slice(from, to).join('\n')
            })
          }
        }

        // Stop once a window reaches the end of the file; another stride would
        // only produce a chunk already contained in this one.
        if (end >= lines.length) break
        start += stride
      }

      return chunks
    }
  }
}
