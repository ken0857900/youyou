-- Additive migration only. Requires existing public articles/decision_points and extensions.
-- Execute with the target schema in search_path; never runs backend/schema.sql.
CREATE TABLE IF NOT EXISTS chunks (
    id bigserial PRIMARY KEY,
    article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    decision_point_id integer NOT NULL REFERENCES decision_points(id) ON DELETE CASCADE,
    text text NOT NULL,
    evidence text NOT NULL DEFAULT '',
    embedding vector(1024) NOT NULL,
    tsv tsvector NOT NULL,
    content_hash text NOT NULL,
    article_hash text NOT NULL,
    embedding_model text NOT NULL,
    chunk_version text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(decision_point_id, embedding_model, chunk_version)
);
CREATE INDEX IF NOT EXISTS rag_chunks_article_idx ON chunks(article_id);
CREATE INDEX IF NOT EXISTS rag_chunks_tsv_idx ON chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS rag_chunks_vector_idx ON chunks USING hnsw(embedding vector_cosine_ops);
