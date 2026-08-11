import { prisma } from '../prisma'
import { createEmbedder, toVectorLiteral } from '../ingest/embedder'

/** How many chunks to pull for a question. */
export const TOP_K = 8

/**
 * Cosine distance beyond which a chunk is treated as unrelated to the question.
 *
 * Measured, not guessed. Against an indexed `is-plain-obj`:
 *
 *   "how does it decide a value is a plain object"  -> 0.3613 (index.js, the answer)
 *   off-domain: Stripe webhooks                      -> 0.8099 nearest
 *   off-domain: Kubernetes staging cluster           -> 0.8260 nearest
 *
 * A well-posed question about code that exists lands around 0.36-0.47; questions
 * the repo cannot answer bottom out around 0.81. 0.5 sits in that gap.
 *
 * The scale is specific to this embedding model — re-measure after a provider
 * swap. Note this filters gross irrelevance only: on a small repo a few
 * unrelated chunks still pass, and the prompt is what stops them being cited.
 */
export const MAX_DISTANCE = 0.5

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
