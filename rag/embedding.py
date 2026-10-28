from functools import lru_cache
from threading import Lock

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

MODEL_NAME = "intfloat/multilingual-e5-base"
MODEL_REVISION = "d128750597153bb5987e10b1c3493a34e5a4502a"
EMBEDDING_DIM = 768
MAX_TOKENS = 512
_MODEL_LOCK = Lock()


@lru_cache(maxsize=1)
def _load_model() -> SentenceTransformer:
    model = SentenceTransformer(
        MODEL_NAME,
        revision=MODEL_REVISION,
        device="cpu",
        trust_remote_code=False,
        model_kwargs={"torch_dtype": torch.float32},
    )
    model.max_seq_length = MAX_TOKENS
    return model


def _embed(text: str, prefix: str) -> list[float]:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not text.strip():
        raise ValueError("text must not be empty")

    with _MODEL_LOCK:
        model = _load_model()

    input_text = prefix + text
    token_count = len(
        model.tokenizer(input_text, truncation=False)["input_ids"]
    )
    if token_count > MAX_TOKENS:
        raise ValueError(
            f"Input has {token_count} tokens; limit is {MAX_TOKENS}, "
            "including prefix and special tokens"
        )

    vector = model.encode(
        [input_text],
        batch_size=1,
        prompt="",
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )[0]

    if vector.shape != (EMBEDDING_DIM,):
        raise RuntimeError(f"Unexpected embedding shape: {vector.shape}")
    if not np.isfinite(vector).all():
        raise RuntimeError("Embedding contains non-finite values")

    return vector.tolist()


def embed_query(query: str) -> list[float]:
    """질문 원문을 정규화된 768차원 벡터로 변환한다."""
    return _embed(query, "query: ")


def embed_code(code: str) -> list[float]:
    """코드 원문을 정규화된 768차원 벡터로 변환한다."""
    return _embed(code, "passage: ")