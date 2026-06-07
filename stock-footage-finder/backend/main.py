import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from api.endpoints import router as api_router
from api.api_keys import router as api_keys_router
from api.embeddings import router as embeddings_router
from api.downloads import router as downloads_router
from config import get_settings
from services.api_key_manager import api_key_manager
from database import init_database


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize services on startup
    settings = get_settings()
    print(f"Starting Stock Footage Finder API on {settings.host}:{settings.port}")
    
    # Initialize database
    init_database()
    print("Database initialized successfully")
    
    # Load API keys from environment if not already loaded
    api_key_manager._load_api_keys()
    
    yield
    
    # Cleanup on shutdown
    print("Shutting down Stock Footage Finder API")


logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s in %(module)s: %(message)s")

app = FastAPI(
    title="Stock Footage Finder API",
    description="API for searching multiple stock media sources",
    version="1.0.0",
    lifespan=lifespan
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    try:
        response = await call_next(request)
        duration_ms = (time.time() - start_time) * 1000
        logging.info("%s %s -> %s (%.2f ms)", request.method, request.url.path, response.status_code, duration_ms)
        return response
    except Exception:
        logging.exception("Unhandled exception during %s %s", request.method, request.url.path)
        raise

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite default port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(api_router)
app.include_router(api_keys_router)
app.include_router(embeddings_router)
app.include_router(downloads_router)

@app.get("/")
def read_root():
    return {
        "message": "Stock Footage Finder API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health"
    }

@app.get("/health")
def health_check():
    return {"status": "healthy"}