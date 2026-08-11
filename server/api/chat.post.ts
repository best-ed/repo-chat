import { anthropic } from '@ai-sdk/anthropic'
import { JobStatus } from '@prisma/client'
import { streamText } from 'ai'

import { prisma } from '../utils/prisma'
import { retrieveChunks, withinThreshold } from '../utils/chat/retrieve'
import { NO_CONTEXT_ANSWER, SYSTEM_INSTRUCTIONS, buildContextPrompt } from '../utils/chat/prompt'

const GENERATION_MODEL = 'claude-opus-5'

/** What gets stored on Message.citations and returned to the client. */
interface Citation {
  path: string
  startLine: number
  endLine: number
}

/**
 * Citations are the chunks that were actually retrieved and passed the relevance
 * threshold — resolved before generation, never parsed out of the model's reply.
 * An answer therefore cannot cite something that was not in its context.
 */
function citationsFor(chunks: Array<{ path: string, startLine: number, endLine: number }>): Citation[] {
  return chunks.map(({ path, startLine, endLine }) => ({ path, startLine, endLine }))
}

function citationHeader(citations: Citation[]): string {
  // Headers must be ASCII and paths need not be, so encode rather than raw JSON.
  return encodeURIComponent(JSON.stringify(citations))
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ repoId?: string, question?: string }>(event)
  const repoId = body?.repoId?.trim()
  const question = body?.question?.trim()

  if (!repoId) throw createError({ statusCode: 400, statusMessage: 'A repoId is required.' })
  if (!question) throw createError({ statusCode: 400, statusMessage: 'A question is required.' })

  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { id: true, job: { select: { status: true } } }
  })
  if (!repo) throw createError({ statusCode: 404, statusMessage: 'Repo not found.' })

  const status = repo.job?.status
  if (status !== JobStatus.READY) {
    throw createError({
      statusCode: 409,
      statusMessage: status
        ? `Repository is not ready to answer questions yet (currently ${status}).`
        : 'Repository has not been indexed yet.'
    })
  }

  await prisma.message.create({ data: { repoId, role: 'user', content: question } })

  const retrieved = await retrieveChunks(repoId, question)
  const relevant = withinThreshold(retrieved)

  // Nothing close enough: answer deterministically instead of asking the model
  // to be honest about an empty context. No model call, no citations, no way to
  // invent one.
  if (relevant.length === 0) {
    await prisma.message.create({
      data: { repoId, role: 'assistant', content: NO_CONTEXT_ANSWER, citations: [] }
    })

    setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
    setResponseHeader(event, 'x-citations', citationHeader([]))
    return NO_CONTEXT_ANSWER
  }

  const citations = citationsFor(relevant)

  const result = streamText({
    model: anthropic(GENERATION_MODEL),
    instructions: SYSTEM_INSTRUCTIONS,
    prompt: buildContextPrompt(question, relevant),
    onEnd: async ({ text }) => {
      await prisma.message.create({
        data: { repoId, role: 'assistant', content: text, citations }
      }).catch(() => {
        // A client that disconnects mid-stream can cut this short. Losing the
        // transcript row is acceptable; an unhandled rejection here is not.
      })
    }
  })

  return result.toTextStreamResponse({
    headers: { 'x-citations': citationHeader(citations) }
  })
})
