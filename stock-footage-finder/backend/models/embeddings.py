"""
SQLAlchemy models for storing embeddings and similarity data.
"""

import uuid
import json
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

from sqlalchemy import (
    Column, String, DateTime, Integer, Float, Boolean, Text,
    ForeignKey, Index, UniqueConstraint, LargeBinary, ARRAY
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy.dialects.postgresql import UUID

from models.api_keys import Base


class TextEmbedding(Base):
    """
    Model for storing text embeddings with caching.
    """
    __tablename__ = "text_embeddings"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    text = Column(Text, nullable=False)
    text_hash = Column(String(64), nullable=False, unique=True)  # SHA-256 hash for deduplication
    
    # Embedding data
    embedding_model = Column(String(100), nullable=False)
    embedding_dimension = Column(Integer, nullable=False)
    embedding_vector = Column(LargeBinary, nullable=False)  # Serialized numpy array
    
    # Source and metadata
    source = Column(String(50), nullable=True)  # Where the text came from
    meta_data = Column(Text, nullable=True)  # JSON metadata
    
    # Cache management
    is_cached = Column(Boolean, default=True)
    cache_expires_at = Column(DateTime(timezone=True), nullable=True)
    hit_count = Column(Integer, default=0)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    similarity_matches = relationship("EmbeddingSimilarity", foreign_keys="EmbeddingSimilarity.embedding1_id", back_populates="embedding1")
    
    # Constraints
    __table_args__ = (
        Index('idx_text_embeddings_text_hash', 'text_hash'),
        Index('idx_text_embeddings_source', 'source'),
        Index('idx_text_embeddings_model', 'embedding_model'),
        Index('idx_text_embeddings_cache_expires', 'cache_expires_at'),
    )
    
    def __repr__(self):
        return f"<TextEmbedding(id={self.id}, text_hash={self.text_hash[:8]}..., model={self.embedding_model})>"
    
    def get_embedding_vector(self):
        """Deserialize the embedding vector."""
        import numpy as np
        return np.frombuffer(self.embedding_vector, dtype=np.float32)
    
    def set_embedding_vector(self, vector):
        """Serialize the embedding vector."""
        import numpy as np
        self.embedding_vector = vector.astype(np.float32).tobytes()
        self.embedding_dimension = len(vector)
    
    def get_metadata_dict(self) -> Dict[str, Any]:
        """Get metadata as a dictionary."""
        if self.meta_data:
            try:
                return json.loads(self.meta_data)
            except json.JSONDecodeError:
                return {}
        return {}
    
    def set_metadata_dict(self, metadata_dict: Dict[str, Any]):
        """Set metadata from a dictionary."""
        self.meta_data = json.dumps(metadata_dict) if metadata_dict else None
    
    def is_cache_expired(self) -> bool:
        """Check if the cache entry has expired."""
        if not self.cache_expires_at:
            return False
        return datetime.utcnow() > self.cache_expires_at
    
    def extend_cache(self, ttl_seconds: int):
        """Extend the cache expiration time."""
        self.cache_expires_at = datetime.utcnow() + timedelta(seconds=ttl_seconds)


class EmbeddingSimilarity(Base):
    """
    Model for tracking similarity scores between embeddings.
    """
    __tablename__ = "embedding_similarity"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    embedding1_id = Column(String(36), ForeignKey("text_embeddings.id"), nullable=False)
    embedding2_id = Column(String(36), ForeignKey("text_embeddings.id"), nullable=False)
    
    # Similarity metrics
    cosine_similarity = Column(Float, nullable=False)
    euclidean_distance = Column(Float, nullable=True)
    dot_product = Column(Float, nullable=True)
    
    # Context and metadata
    context = Column(String(100), nullable=True)  # e.g., "search", "recommendation"
    meta_data = Column(Text, nullable=True)  # JSON metadata
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    embedding1 = relationship("TextEmbedding", foreign_keys=[embedding1_id], back_populates="similarity_matches")
    embedding2 = relationship("TextEmbedding", foreign_keys=[embedding2_id])
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('embedding1_id', 'embedding2_id', 'context', name='uq_embedding_similarity'),
        Index('idx_embedding_similarity_score', 'cosine_similarity'),
        Index('idx_embedding_similarity_context', 'context'),
        Index('idx_embedding_similarity_created_at', 'created_at'),
    )
    
    def __repr__(self):
        return f"<EmbeddingSimilarity(id={self.id}, similarity={self.cosine_similarity:.3f})>"
    
    def get_metadata_dict(self) -> Dict[str, Any]:
        """Get metadata as a dictionary."""
        if self.meta_data:
            try:
                return json.loads(self.meta_data)
            except json.JSONDecodeError:
                return {}
        return {}
    
    def set_metadata_dict(self, metadata_dict: Dict[str, Any]):
        """Set metadata from a dictionary."""
        self.meta_data = json.dumps(metadata_dict) if metadata_dict else None


class MediaEmbedding(Base):
    """
    Model for storing embeddings associated with media items.
    """
    __tablename__ = "media_embeddings"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    media_id = Column(String(100), nullable=False)  # ID from the source API
    media_source = Column(String(50), nullable=False)  # pexels, pixabay, etc.
    media_type = Column(String(20), nullable=False)  # video, image
    
    # Text content that was embedded
    title = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    tags = Column(Text, nullable=True)  # JSON array of tags
    combined_text = Column(Text, nullable=False)  # Combined text for embedding
    
    # Embedding data
    embedding_model = Column(String(100), nullable=False)
    embedding_dimension = Column(Integer, nullable=False)
    embedding_vector = Column(LargeBinary, nullable=False)
    
    # Quality and relevance metrics
    relevance_score = Column(Float, nullable=True)
    quality_score = Column(Float, nullable=True)
    popularity_score = Column(Float, nullable=True)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('media_id', 'media_source', 'embedding_model', name='uq_media_embedding'),
        Index('idx_media_embeddings_source', 'media_source'),
        Index('idx_media_embeddings_type', 'media_type'),
        Index('idx_media_embeddings_relevance', 'relevance_score'),
        Index('idx_media_embeddings_created_at', 'created_at'),
    )
    
    def __repr__(self):
        return f"<MediaEmbedding(id={self.id}, media_id={self.media_id}, source={self.media_source})>"
    
    def get_embedding_vector(self):
        """Deserialize the embedding vector."""
        import numpy as np
        return np.frombuffer(self.embedding_vector, dtype=np.float32)
    
    def set_embedding_vector(self, vector):
        """Serialize the embedding vector."""
        import numpy as np
        self.embedding_vector = vector.astype(np.float32).tobytes()
        self.embedding_dimension = len(vector)
    
    def get_tags_list(self) -> List[str]:
        """Get tags as a list."""
        if self.tags:
            try:
                return json.loads(self.tags)
            except json.JSONDecodeError:
                return []
        return []
    
    def set_tags_list(self, tags_list: List[str]):
        """Set tags from a list."""
        self.tags = json.dumps(tags_list) if tags_list else None


class EmbeddingCache(Base):
    """
    Model for managing embedding cache with TTL and usage statistics.
    """
    __tablename__ = "embedding_cache"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    cache_key = Column(String(255), nullable=False, unique=True)
    text_hash = Column(String(64), nullable=False)
    
    # Cache statistics
    hit_count = Column(Integer, default=0)
    last_accessed_at = Column(DateTime(timezone=True), nullable=True)
    
    # Cache management
    is_active = Column(Boolean, default=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    
    # Size tracking
    text_length = Column(Integer, nullable=False)
    embedding_size_bytes = Column(Integer, nullable=False)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Constraints
    __table_args__ = (
        Index('idx_embedding_cache_key', 'cache_key'),
        Index('idx_embedding_cache_expires', 'expires_at'),
        Index('idx_embedding_cache_accessed', 'last_accessed_at'),
        Index('idx_embedding_cache_hits', 'hit_count'),
    )
    
    def __repr__(self):
        return f"<EmbeddingCache(id={self.id}, cache_key={self.cache_key[:20]}..., hits={self.hit_count})>"
    
    def is_expired(self) -> bool:
        """Check if the cache entry has expired."""
        return datetime.utcnow() > self.expires_at
    
    def is_active_and_not_expired(self) -> bool:
        """Check if the cache entry is active and not expired."""
        return self.is_active and not self.is_expired()
    
    def update_access(self):
        """Update access statistics."""
        self.hit_count += 1
        self.last_accessed_at = datetime.utcnow()


class EmbeddingUsage(Base):
    """
    Model for tracking embedding API usage and quotas.
    """
    __tablename__ = "embedding_usage"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    
    # Usage counters
    requests_count = Column(Integer, default=0)
    tokens_used = Column(Integer, default=0)
    texts_processed = Column(Integer, default=0)
    
    # Time period for this record
    period_type = Column(String(10), nullable=False)  # 'hour', 'day', 'month'
    period_start = Column(DateTime(timezone=True), nullable=False)
    
    # Additional metrics
    avg_response_time = Column(Float, nullable=True)  # in milliseconds
    cache_hit_rate = Column(Float, nullable=True)  # percentage
    error_count = Column(Integer, default=0)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('period_type', 'period_start', name='uq_embedding_usage_period'),
        Index('idx_period_type_start', 'period_type', 'period_start'),
    )
    
    def __repr__(self):
        return f"<EmbeddingUsage(period={self.period_type}, requests={self.requests_count}, tokens={self.tokens_used})>"