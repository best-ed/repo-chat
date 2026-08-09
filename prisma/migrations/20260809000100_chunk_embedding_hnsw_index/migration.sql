-- Prisma cannot manage indexes on an `Unsupported()` column, so the ANN index
-- for Chunk.embedding is declared here as raw SQL instead of in schema.prisma.
--
-- Cosine distance (`<=>`) is the operator the retrieval query will use, so the
-- index has to be built with the matching opclass or Postgres will ignore it.
CREATE INDEX "Chunk_embedding_hnsw_idx"
    ON "Chunk"
    USING hnsw ("embedding" vector_cosine_ops);
