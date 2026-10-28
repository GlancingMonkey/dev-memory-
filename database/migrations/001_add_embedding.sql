
-- Issue #14: Add nullable E5 embedding column.
-- Preserve existing snippets and allow NULL embeddings.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE public.snippets
ADD COLUMN IF NOT EXISTS embedding vector(768);

COMMIT;
  