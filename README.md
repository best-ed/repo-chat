# repo-chat

Paste a public GitHub repository URL, let the system index it, then ask questions
about the codebase. Answers cite the file paths and line ranges they were drawn
from, so every claim can be checked against the source.

## Stack

Nuxt 3 + Nitro · Prisma + Postgres with pgvector · Vercel AI SDK with Claude for
generation · Tailwind CSS · deployed on Vercel.

## Status

**The core loop works end to end.** A repository can be ingested — downloaded,
chunked, and embedded — and then asked questions: the question is embedded,
the nearest chunks are retrieved, and Claude answers from those excerpts with
streamed output and citations linking to the exact lines on GitHub. When nothing
relevant is retrieved, the answer says so instead of guessing.

## Setup

```bash
npm install
cp .env.example .env    # fill in the database URLs and the model keys
npx prisma migrate deploy
npm run dev
```

### Environment

Both database URLs point at the same Postgres, which must be able to load the
`vector` extension. `DATABASE_URL` is the pooled (pgbouncer) connection the app
uses at runtime; `DATABASE_DIRECT_URL` is the direct, unpooled one, because
`prisma migrate` needs session features the pooler strips. Locally, with no
pooler in front of the database, the two can be the same string.

`GITHUB_TOKEN` is optional but effectively required in practice. Ingestion spends
three GitHub API calls per repository (metadata, head commit, tarball), and
unauthenticated access is capped at 60 requests/hour — enough to exhaust in a few
minutes of testing. A token raises the ceiling to 5000/hour. Without one,
ingestion still works and fails with an explicit rate-limit message when the
budget runs out.

`ANTHROPIC_API_KEY` covers generation. Embeddings sit behind a config-swappable
seam — `EMBEDDINGS_API_KEY`, `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL` — currently
pointed at NVIDIA's `nv-embedcode-7b-v1`, a code-specialized model on a free
endpoint. Nothing in the code names a provider, so switching is a config change
plus a re-embed. Any embedder works as long as it emits **4096-dimension**
vectors, which is what the schema is committed to.

## Data model

`prisma/schema.prisma` is the source of truth. Four models: `Repo`, `Job`,
`Chunk`, and `Message`. Chunk embeddings are `vector(4096)`, held as an
`Unsupported` column because Prisma has no native vector type — which also means
vectors are read and written with raw SQL rather than through the generated
client.

Retrieval uses an exact cosine scan with the `<=>` operator rather than an ANN
index. pgvector caps HNSW and ivfflat at 2000 dimensions, so no cosine index is
available at 4096; the earlier HNSW index was dropped when the column widened.
That is a deliberate trade — code-specialized embeddings over ANN indexability —
and an exact scan is both correct and fast at this scale, where a repository is
capped at 500 files and a few thousand chunks. If it ever needs to scale, the
path is a binary-quantized HNSW index used as a prefilter with an exact rerank.
