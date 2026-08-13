import { prisma } from '../prisma'
import { createEmbedder, toVectorLiteral } from '../ingest/embedder'

/** How many chunks to pull for a question. */
export const TOP_K = 8

/**
 * Cosine distance beyond which a chunk is treated as unrelated to the question.
 *
 * Calibrated against 38 questions across four repositories of different shapes
 * (is-plain-obj, collab-crdt, p-queue, scripts-to-rule-them-all) — see
 * `scripts/measure-retrieval.mjs`, which reproduces the numbers:
 *
 *   specific questions      nearest distance maxed at 0.7061
 *   unanswerable questions  nearest distance bottomed at 0.7498
 *
 * The two classes separate cleanly, and they separate inside every repository
 * individually — no unanswerable question landed nearer than any specific one.
 * 0.72 sits in that gap: it admits all 14 specific questions and none of the 12
 * unanswerable ones. It is set buffered below the observed 0.7498 floor rather
 * than at it, because that floor is the minimum of a 12-question sample and the
 * true off-domain distribution almost certainly has a tail below it. Calibrating
 * to the exact observed edge is what put the previous value (0.5) a quarter of
 * the scale too low: it was fitted to a single lucky question on one small repo.
 *
 * Abstract questions ("what does this repo do?") straddle the unanswerable
 * range, so 0.72 refuses most of them. That is the deliberate trade — refusing a
 * vague question is a mild, honest failure; admitting an off-domain one invites
 * fabrication, which this tool exists not to do.
 *
 * The scale is specific to this embedding model — re-measure after a provider
 * swap. Note this filters gross irrelevance only: on a small repo a few
 * unrelated chunks still pass, and the prompt is what stops them being cited.
 */
export const MAX_DISTANCE = 0.72

export interface RetrievedChunk {
  path: string
  startLine: number
  endLine: number
  content: string
  /** pgvector cosine distance: 0 is identical, 2 is opposite. */
  distance: number
}

const embedder = createEmbedder()

/**
 * Nearest chunks to a question within one repository.
 *
 * There is no ANN index at 4096 dimensions, so this is an exact scan ordered by
 * cosine distance — slower than HNSW at scale, but exact.
 *
 * The embedding column is deliberately absent from the select list: reading it
 * back through the Prisma client fails to deserialize the pgvector type. Using
 * it inside an expression is fine, since what comes back is a float.
 */
export async function retrieveChunks(
  repoId: string,
  question: string,
  limit: number = TOP_K
): Promise<RetrievedChunk[]> {
  // The question is embedded as a query, not a passage. This model happens to
  // return the same vector either way, but the provider requires a valid input
  // type and an asymmetric model would need this to be right.
  const [vector] = await embedder.embed([question], 'query')
  const literal = toVectorLiteral(vector!)

  return prisma.$queryRaw<RetrievedChunk[]>`
    SELECT path,
           "startLine",
           "endLine",
           content,
           (embedding <=> ${literal}::vector) AS distance
    FROM "Chunk"
    WHERE "repoId" = ${repoId} AND embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit}
  `
}

/** Chunks close enough to be worth showing the model. */
export function withinThreshold(
  chunks: RetrievedChunk[],
  maxDistance: number = MAX_DISTANCE
): RetrievedChunk[] {
  return chunks.filter((chunk) => chunk.distance <= maxDistance)
}
