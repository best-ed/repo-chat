import type { RetrievedChunk } from './retrieve'

/**
 * Shown to the user verbatim when nothing relevant was retrieved. The model is
 * never asked in that case — there is nothing for it to ground an answer in, and
 * asking anyway is how a plausible-sounding fabrication gets produced.
 */
export const NO_CONTEXT_ANSWER =
  "I couldn't find anything relevant to that in this repository, so I can't answer it from the code. " +
  'Try rephrasing, or asking about something the repository actually contains.'

export const SYSTEM_INSTRUCTIONS = `You answer questions about a specific code repository, using only excerpts from that repository which are provided to you.

Rules:
- Answer only from the provided excerpts. They are the entire evidence available to you.
- Cite the file path and line range for each claim you make, in the form \`path/to/file.ts:12-40\`.
- Only cite a path and line range that appears in the excerpts. Never cite a file you were not given, and never widen a line range beyond what you were given.
- The excerpts are retrieved by similarity, so some may be irrelevant. Ignore those rather than forcing them into an answer.
- If the excerpts do not contain the answer, say so plainly and stop. Do not fall back on general knowledge about similar libraries, and do not guess.
- Be concise and concrete. Quote or describe the actual code rather than paraphrasing it vaguely.`

/** Renders retrieved chunks as labelled excerpts the model can cite precisely. */
export function buildContextPrompt(question: string, chunks: RetrievedChunk[]): string {
  const excerpts = chunks
    .map((chunk) => {
      const header = `${chunk.path}:${chunk.startLine}-${chunk.endLine}`
      return `--- ${header} ---\n${chunk.content}`
    })
    .join('\n\n')

  return `Repository excerpts:\n\n${excerpts}\n\nQuestion: ${question}`
}
