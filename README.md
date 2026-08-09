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
cp .env.example .env    # fill in DATABASE_URL and the model keys
npx prisma migrate deploy
npm run dev
```

`DATABASE_URL` must point at a Postgres that can load the `vector` extension, and
must be a direct (non-pooled) connection — `prisma/schema.prisma` declares no
`directUrl`, and pgbouncer breaks `prisma migrate`.

## Data model

`prisma/schema.prisma` is the source of truth. Four models: `Repo`, `Job`,
`Chunk`, and `Message`. Chunk embeddings are `vector(1536)`, held as an
`Unsupported` column because Prisma has no native vector type — which also means
the ANN index is declared as raw SQL in
`prisma/migrations/20260809000100_chunk_embedding_hnsw_index`, an HNSW index using
`vector_cosine_ops` to match the cosine distance operator retrieval will use.
