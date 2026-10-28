from fastapi import FastAPI

from backend.routers.search import router as search_router
from backend.routers.snippets import router as snippets_router

app = FastAPI(title="Capstone RAG API")
app.include_router(snippets_router)
app.include_router(search_router)


@app.get("/health")
def health_check():
    return {"status": "ok"}