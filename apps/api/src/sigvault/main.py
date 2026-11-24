from fastapi import FastAPI

from .routers import documents, health, keys, orgs

app = FastAPI(title="sigvault-api", version="0.1.0", docs_url=None, redoc_url=None)
app.include_router(health.router)
app.include_router(orgs.router, prefix="/api")
app.include_router(keys.router, prefix="/api")
app.include_router(documents.router, prefix="/api")
