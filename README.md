# repo-chat

Paste a public GitHub repository URL, let the system index it, then ask questions
about the codebase. Answers cite the file paths and line ranges they were drawn
from, so every claim can be checked against the source.

## Stack

Nuxt 3 + Nitro · Prisma + Postgres with pgvector · Vercel AI SDK with Claude for
generation · Tailwind CSS · deployed on Vercel.

## Status

**Phase 1 — scaffolding only.** The app builds and the schema is migrated, but
nothing is wired up yet: there is no cloning, chunking, embedding, retrieval, or
chat endpoint. The UI is a static shell.

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

`ANTHROPIC_API_KEY` covers generation. Embeddings are configured generically —
`EMBEDDINGS_API_KEY`, `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL` — because the
provider is deliberately undecided until the embedding phase. Any embedder works
as long as it emits **1536-dimension** vectors, which is what the schema is
committed to.

## Data model

`prisma/schema.prisma` is the source of truth. Four models: `Repo`, `Job`,
`Chunk`, and `Message`. Chunk embeddings are `vector(1536)`, held as an
`Unsupported` column because Prisma has no native vector type — which also means
the ANN index is declared as raw SQL in
`prisma/migrations/20260809000100_chunk_embedding_hnsw_index`, an HNSW index using
`vector_cosine_ops` to match the cosine distance operator retrieval will use.
