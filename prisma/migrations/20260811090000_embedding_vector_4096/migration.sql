-- Widen Chunk.embedding from vector(1536) to vector(4096) for
-- nv-embedcode-7b-v1.
--
-- The HNSW index cannot survive the change and is NOT recreated. pgvector 0.8.0
-- caps hnsw (and ivfflat) at 2000 dimensions for the `vector` type, and at 4000
-- for `halfvec` — both verified against this database:
--
--   hnsw (embedding vector_cosine_ops)              -> 54000: more than 2000 dimensions
--   hnsw ((embedding::halfvec(4096)) halfvec_...)   -> 54000: more than 4000 dimensions
--
-- So no cosine ANN index exists at this width. Retrieval does an exact scan with
-- the <=> operator, which is slower at scale but exact rather than approximate.
-- If an index becomes necessary, the working option is a binary-quantized HNSW
-- index used as a prefilter plus an exact rerank.
DROP INDEX IF EXISTS "Chunk_embedding_hnsw_idx";

-- Safe as a plain type change because no embeddings have been written yet;
-- there is no 1536-wide value that would need converting to 4096.
ALTER TABLE "Chunk" ALTER COLUMN "embedding" TYPE vector(4096);
