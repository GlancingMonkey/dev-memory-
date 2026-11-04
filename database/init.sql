CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS snippets (
    id BIGSERIAL PRIMARY KEY,
    project_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    function_name TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    code TEXT NOT NULL,
    embedding vector(768),
    embedding_status TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT snippets_embedding_statuss_check
        CHECK (embedding_status IN ('pending', 'ready', 'failed')),
    embedding_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snippets_project_name
    ON snippets(project_name);

CREATE INDEX IF NOT EXISTS idx_snippets_language
    ON snippets(language);
    