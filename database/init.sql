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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snippets_project_name
    ON snippets(project_name);

CREATE INDEX IF NOT EXISTS idx_snippets_language
    ON snippets(language);
    