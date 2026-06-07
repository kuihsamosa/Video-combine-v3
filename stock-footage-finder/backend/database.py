"""
Database configuration and session management.
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.ext.declarative import declarative_base

from config import get_settings

# Create a unified Base class that includes all models
Base = declarative_base()

# Import all models to ensure they are registered with SQLAlchemy
from models.api_keys import APIKey, APIKeyUsage, APIKeyHistory
from models.embeddings import (
    TextEmbedding, EmbeddingSimilarity, MediaEmbedding,
    EmbeddingCache, EmbeddingUsage
)
from models.downloads import Download, DownloadChunk, DownloadHistory, DownloadStatistics

# Global variables
engine = None
SessionLocal = None

def get_database_url():
    """Get the database URL based on configuration."""
    settings = get_settings()
    
    # Default to SQLite for simplicity
    db_path = os.path.join(os.getcwd(), "stock_footage_finder.db")
    return f"sqlite:///{db_path}"

def init_database():
    """Initialize the database engine and session."""
    global engine, SessionLocal
    
    database_url = get_database_url()
    
    # Create engine
    if database_url.startswith("sqlite"):
        engine = create_engine(
            database_url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool
        )
    else:
        engine = create_engine(database_url)
    
    # Create session factory
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    
    # Create tables
    Base.metadata.create_all(bind=engine)

def get_db() -> Session:
    """Get a database session."""
    if SessionLocal is None:
        init_database()
    
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()