from fastapi import FastAPI

from backend.routers.snippets import router as snippets_router

app = FastAPI(title="Capstone RAG API")
app.include_router(snippets_router)


@app.get("/health")
def health_check():
    return {"status": "ok"}
