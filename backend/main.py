import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.routers.ask import router as ask_router
from backend.routers.search import router as search_router
from backend.routers.snippets import router as snippets_router
from rag.embedding import warmup_model

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Preparing E5 model...", flush=True)

    try:
        warmup_model()
    except Exception:
        logger.exception("E5 warmup failed")
    else:
        print("E5 warmup: OK", flush=True)

    yield


app = FastAPI(
    title="Capstone RAG API",
    lifespan=lifespan,
)

app.include_router(snippets_router)
app.include_router(search_router)
app.include_router(ask_router)


@app.get("/health")
def health_check():
    return {"status": "ok"}
