-- 임베딩 처리 상태와 실패 사유를 기록하는 컬럼 추가
-- 기존 스니펫의 ID, 원문, 메타데이터, 벡터는 유지

BEGIN;

ALTER TABLE public.snippets
    ADD COLUMN embedding_status TEXT,
    ADD COLUMN embedding_error TEXT;

-- 기존 벡터가 있으면 완료, 없으면 미처리 상태로 설정
UPDATE public.snippets
SET embedding_status = CASE
    WHEN embedding IS NOT NULL THEN 'ready'
    ELSE 'pending'
END;

ALTER TABLE public.snippets
    ALTER COLUMN embedding_status SET DEFAULT 'pending',
    ALTER COLUMN embedding_status SET NOT NULL;

ALTER TABLE public.snippets
    ADD CONSTRAINT snippets_embedding_status_check
    CHECK (embedding_status IN ('pending', 'ready', 'failed'));

COMMIT;
