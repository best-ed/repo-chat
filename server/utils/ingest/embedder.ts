import { IngestError } from './github'

/**
 * Embedding sits behind this interface so the provider is a configuration
 * choice, not a code change. Nothing here names a vendor or a model — all three
 * come from the environment.
 */

/** Dimensionality the Chunk.embedding column is declared with. */
export const EMBEDDING_DIMENSIONS = 4096

/** Texts per request. The API accepts an array; one call per chunk would be wasteful. */
export const EMBEDDING_BATCH_SIZE = 32

const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 500

/**
 * Whether the text being embedded is a stored document or a search query.
 *
 * This is load-bearing, not cosmetic: asymmetric models place queries and
 * passages differently, and embedding a query as a passage degrades retrieval
 * quietly — results stay plausible while getting worse. Chunks are always
 * 'passage'; 'query' is used at search time.
 */
export type EmbeddingInputType = 'passage' | 'query'

export interface Embedder {
  readonly dimensions: number
  /** Every text in one call must share an input type; never mix the two. */
  embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>
}

interface EmbeddingsConfig {
  apiKey: string
  baseUrl: string
  model: string
}

function readConfig(): EmbeddingsConfig {
  const apiKey = process.env.EMBEDDINGS_API_KEY
  const baseUrl = process.env.EMBEDDINGS_BASE_URL
  const model = process.env.EMBEDDINGS_MODEL

  const missing = [
    ['EMBEDDINGS_API_KEY', apiKey],
    ['EMBEDDINGS_BASE_URL', baseUrl],
    ['EMBEDDINGS_MODEL', model]
  ].filter(([, value]) => !value).map(([name]) => name)

  if (missing.length > 0) {
    throw new IngestError(`Embeddings are not configured: ${missing.join(', ')} not set.`)
  }

  return {
    apiKey: apiKey!,
    baseUrl: baseUrl!.replace(/\/+$/, ''),
    model: model!
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Rate limiting and transient server faults are worth retrying; nothing else is. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * OpenAI-compatible embeddings client. Any provider speaking that shape works by
 * changing EMBEDDINGS_BASE_URL and EMBEDDINGS_MODEL.
 */
export function createEmbedder(dimensions: number = EMBEDDING_DIMENSIONS): Embedder {
  return {
    dimensions,

    async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
      if (texts.length === 0) return []
      const config = readConfig()

      let lastError = ''

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let response: Response
        try {
          response = await fetch(`${config.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model: config.model,
              input: texts,
              input_type: inputType,
              encoding_format: 'float'
            })
          })
        } catch (error) {
          lastError = `network error: ${error instanceof Error ? error.message : String(error)}`
          if (attempt === MAX_ATTEMPTS) break
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
          continue
        }

        if (response.ok) {
          const payload = await response.json() as {
            data?: Array<{ index?: number, embedding?: number[] }>
          }
          const rows = payload.data
          if (!Array.isArray(rows) || rows.length !== texts.length) {
            throw new IngestError(
              `Embeddings provider returned ${rows?.length ?? 0} vectors for ${texts.length} inputs.`
            )
          }

          // The response carries an explicit index; ordering is not promised.
          const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

          return ordered.map((row, i) => {
            const vector = row.embedding
            if (!Array.isArray(vector)) {
              throw new IngestError(`Embeddings provider returned no vector for input ${i}.`)
            }
            if (vector.length !== dimensions) {
              throw new IngestError(
                `Embeddings provider returned ${vector.length}-dimension vectors, but the schema expects ${dimensions}.`
              )
            }
            return vector
          })
        }

        const body = (await response.text().catch(() => '')).slice(0, 200)
        lastError = `HTTP ${response.status}${body ? ` — ${body}` : ''}`

        if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) break

        // Honour Retry-After when the provider sends one, else exponential.
        const retryAfter = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * 2 ** (attempt - 1)
        await sleep(delay)
      }

      throw new IngestError(`Embeddings request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`)
    }
  }
}

/**
 * Renders a vector as a pgvector literal. Every element is checked to be a
 * finite number, so the resulting string can only ever contain numerics — it is
 * still passed as a bound parameter rather than concatenated into SQL.
 */
export function toVectorLiteral(vector: number[]): string {
  const parts = vector.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new IngestError('Embeddings provider returned a non-numeric vector component.')
    }
    return String(value)
  })
  return `[${parts.join(',')}]`
}
