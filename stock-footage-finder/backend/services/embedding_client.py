"""
Embedding client for generating text embeddings using OpenRouter API.
Includes caching, quota management, and batch processing capabilities.
"""

import hashlib
import json
import time
from typing import Dict, List, Optional, Tuple, Any, Union
from datetime import datetime, timedelta

import httpx
import numpy as np
from sqlalchemy.orm import Session
from tenacity import retry, stop_after_attempt, wait_exponential

from config import get_settings
from database import get_db
from models.embeddings import (
    TextEmbedding, EmbeddingCache, EmbeddingUsage
)


class EmbeddingClient:
    """
    Client for generating text embeddings with caching and quota management.
    """
    
    def __init__(self):
        self.settings = get_settings()
        self.client = httpx.AsyncClient(timeout=30.0)
        self._last_request_time = 0
        self._min_request_interval = 0.1  # Minimum time between requests (seconds)
    
    async def __aenter__(self):
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.client.aclose()
    
    def _get_text_hash(self, text: str) -> str:
        """Generate SHA-256 hash for text deduplication."""
        return hashlib.sha256(text.encode('utf-8')).hexdigest()
    
    def _get_cache_key(self, text: str, model: str) -> str:
        """Generate cache key for text and model combination."""
        text_hash = self._get_text_hash(text)
        return f"{model}:{text_hash}"
    
    def _rate_limit(self):
        """Simple rate limiting to avoid overwhelming the API."""
        current_time = time.time()
        time_since_last = current_time - self._last_request_time
        if time_since_last < self._min_request_interval:
            time.sleep(self._min_request_interval - time_since_last)
        self._last_request_time = time.time()
    
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    async def _make_request(self, text: str, model: str) -> List[float]:
        """Make API request to OpenRouter for embeddings."""
        if not self.settings.openrouter_api_key:
            raise ValueError("OpenRouter API key not configured")
        
        self._rate_limit()
        
        headers = {
            "Authorization": f"Bearer {self.settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://stock-footage-finder.local",
            "X-Title": "Stock Footage Finder"
        }
        
        data = {
            "model": model,
            "input": text
        }
        
        url = f"{self.settings.openrouter_base_url}/embeddings"
        response = await self.client.post(url, headers=headers, json=data)
        response.raise_for_status()
        
        result = response.json()
        if "data" not in result or not result["data"]:
            raise ValueError("Invalid response from embedding API")
        
        return result["data"][0]["embedding"]
    
    def _track_usage(self, db: Session, tokens_used: int, texts_processed: int, 
                     response_time: float, success: bool = True):
        """Track API usage for quota management."""
        now = datetime.utcnow()
        
        # Track usage for different periods
        for period_type in ['hour', 'day', 'month']:
            # Calculate period start
            if period_type == 'hour':
                period_start = now.replace(minute=0, second=0, microsecond=0)
            elif period_type == 'day':
                period_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            else:  # month
                period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            
            # Find or create usage record
            usage = db.query(EmbeddingUsage).filter(
                EmbeddingUsage.period_type == period_type,
                EmbeddingUsage.period_start == period_start
            ).first()
            
            if not usage:
                usage = EmbeddingUsage(
                    period_type=period_type,
                    period_start=period_start
                )
                db.add(usage)
            
            # Update usage
            usage.requests_count += 1
            usage.tokens_used += tokens_used
            usage.texts_processed += texts_processed
            
            if not success:
                usage.error_count += 1
            
            if usage.avg_response_time is None:
                usage.avg_response_time = response_time
            else:
                # Calculate new average
                total_requests = usage.requests_count
                usage.avg_response_time = (
                    (usage.avg_response_time * (total_requests - 1) + response_time) / 
                    total_requests
                )
            
            usage.updated_at = now
        
        db.commit()
    
    def _get_cached_embedding(self, db: Session, cache_key: str, text_hash: str) -> Optional[np.ndarray]:
        """Get embedding from cache."""
        # Check text embeddings table first
        text_embedding = db.query(TextEmbedding).filter(
            TextEmbedding.text_hash == text_hash,
            TextEmbedding.embedding_model == self.settings.embedding_model
        ).first()
        
        if text_embedding and not text_embedding.is_cache_expired():
            text_embedding.hit_count += 1
            db.commit()
            return text_embedding.get_embedding_vector()
        
        # Check cache table
        cache_entry = db.query(EmbeddingCache).filter(
            EmbeddingCache.cache_key == cache_key
        ).first()
        
        if cache_entry and cache_entry.is_active_and_not_expired():
            cache_entry.update_access()
            db.commit()
            
            # Get the actual embedding
            text_embedding = db.query(TextEmbedding).filter(
                TextEmbedding.text_hash == text_hash
            ).first()
            
            if text_embedding:
                return text_embedding.get_embedding_vector()
        
        return None
    
    def _cache_embedding(self, db: Session, text: str, embedding: np.ndarray, 
                        source: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None):
        """Cache embedding in database."""
        text_hash = self._get_text_hash(text)
        cache_key = self._get_cache_key(text, self.settings.embedding_model)
        
        # Create or update text embedding
        text_embedding = db.query(TextEmbedding).filter(
            TextEmbedding.text_hash == text_hash,
            TextEmbedding.embedding_model == self.settings.embedding_model
        ).first()
        
        if not text_embedding:
            text_embedding = TextEmbedding(
                text=text,
                text_hash=text_hash,
                embedding_model=self.settings.embedding_model,
                source=source
            )
            db.add(text_embedding)
        
        # Update embedding data
        text_embedding.set_embedding_vector(embedding)
        text_embedding.is_cached = True
        text_embedding.extend_cache(self.settings.embedding_cache_ttl)
        
        if metadata:
            text_embedding.set_metadata_dict(metadata)
        
        # Create or update cache entry
        cache_entry = db.query(EmbeddingCache).filter(
            EmbeddingCache.cache_key == cache_key
        ).first()
        
        if not cache_entry:
            cache_entry = EmbeddingCache(
                cache_key=cache_key,
                text_hash=text_hash,
                expires_at=datetime.utcnow() + timedelta(seconds=self.settings.embedding_cache_ttl),
                text_length=len(text),
                embedding_size_bytes=len(embedding.tobytes())
            )
            db.add(cache_entry)
        else:
            cache_entry.expires_at = datetime.utcnow() + timedelta(seconds=self.settings.embedding_cache_ttl)
        
        db.commit()
    
    async def get_embedding(
        self, 
        text: str, 
        db: Session,
        source: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        use_cache: bool = True
    ) -> np.ndarray:
        """
        Get embedding for a single text.
        
        Args:
            text: Text to embed
            db: Database session
            source: Source of the text (optional)
            metadata: Additional metadata (optional)
            use_cache: Whether to use cached embeddings
            
        Returns:
            Embedding vector as numpy array
        """
        if not text or not text.strip():
            raise ValueError("Text cannot be empty")
        
        text = text.strip()
        text_hash = self._get_text_hash(text)
        cache_key = self._get_cache_key(text, self.settings.embedding_model)
        
        # Check cache first
        if use_cache:
            cached_embedding = self._get_cached_embedding(db, cache_key, text_hash)
            if cached_embedding is not None:
                return cached_embedding
        
        # Generate new embedding
        start_time = time.time()
        try:
            embedding_vector = await self._make_request(text, self.settings.embedding_model)
            response_time = (time.time() - start_time) * 1000  # Convert to milliseconds
            
            embedding = np.array(embedding_vector, dtype=np.float32)
            
            # Cache the embedding
            self._cache_embedding(db, text, embedding, source, metadata)
            
            # Track usage
            # Estimate tokens (rough approximation: 1 token ≈ 4 characters)
            estimated_tokens = max(1, len(text) // 4)
            self._track_usage(db, estimated_tokens, 1, response_time, success=True)
            
            return embedding
            
        except Exception as e:
            response_time = (time.time() - start_time) * 1000
            estimated_tokens = max(1, len(text) // 4)
            self._track_usage(db, estimated_tokens, 1, response_time, success=False)
            raise e
    
    async def get_embeddings_batch(
        self,
        texts: List[str],
        db: Session,
        source: Optional[str] = None,
        metadata_list: Optional[List[Dict[str, Any]]] = None,
        use_cache: bool = True
    ) -> List[np.ndarray]:
        """
        Get embeddings for multiple texts efficiently.
        
        Args:
            texts: List of texts to embed
            db: Database session
            source: Source of the texts (optional)
            metadata_list: List of metadata dictionaries (optional)
            use_cache: Whether to use cached embeddings
            
        Returns:
            List of embedding vectors as numpy arrays
        """
        if not texts:
            return []
        
        if metadata_list is None:
            metadata_list = [None] * len(texts)
        elif len(metadata_list) != len(texts):
            raise ValueError("metadata_list must have the same length as texts")
        
        embeddings = []
        texts_to_process = []
        indices_to_process = []
        
        # Check cache for each text
        if use_cache:
            for i, text in enumerate(texts):
                if not text or not text.strip():
                    embeddings.append(np.array([]))
                    continue
                
                text = text.strip()
                text_hash = self._get_text_hash(text)
                cache_key = self._get_cache_key(text, self.settings.embedding_model)
                
                cached_embedding = self._get_cached_embedding(db, cache_key, text_hash)
                if cached_embedding is not None:
                    embeddings.append(cached_embedding)
                else:
                    embeddings.append(None)  # Placeholder
                    texts_to_process.append(text)
                    indices_to_process.append(i)
        else:
            texts_to_process = texts
            indices_to_process = list(range(len(texts)))
            embeddings = [None] * len(texts)
        
        # Process uncached texts in batches
        if texts_to_process:
            batch_size = min(self.settings.embedding_batch_size, len(texts_to_process))
            
            for i in range(0, len(texts_to_process), batch_size):
                batch_texts = texts_to_process[i:i + batch_size]
                batch_indices = indices_to_process[i:i + batch_size]
                batch_metadata = [metadata_list[idx] for idx in batch_indices]
                
                start_time = time.time()
                try:
                    # Make batch API request
                    batch_embeddings = await self._make_request_batch(batch_texts)
                    response_time = (time.time() - start_time) * 1000
                    
                    # Cache and store results
                    for j, (text, embedding, metadata) in enumerate(zip(batch_texts, batch_embeddings, batch_metadata)):
                        embedding_array = np.array(embedding, dtype=np.float32)
                        original_index = batch_indices[j]
                        
                        # Cache the embedding
                        self._cache_embedding(db, text, embedding_array, source, metadata)
                        
                        # Store in result list
                        embeddings[original_index] = embedding_array
                    
                    # Track usage
                    total_chars = sum(len(text) for text in batch_texts)
                    estimated_tokens = max(len(batch_texts), total_chars // 4)
                    self._track_usage(db, estimated_tokens, len(batch_texts), response_time, success=True)
                    
                except Exception as e:
                    response_time = (time.time() - start_time) * 1000
                    total_chars = sum(len(text) for text in batch_texts)
                    estimated_tokens = max(len(batch_texts), total_chars // 4)
                    self._track_usage(db, estimated_tokens, len(batch_texts), response_time, success=False)
                    raise e
        
        return embeddings
    
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    async def _make_request_batch(self, texts: List[str]) -> List[List[float]]:
        """Make batch API request to OpenRouter for embeddings."""
        if not self.settings.openrouter_api_key:
            raise ValueError("OpenRouter API key not configured")
        
        self._rate_limit()
        
        headers = {
            "Authorization": f"Bearer {self.settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://stock-footage-finder.local",
            "X-Title": "Stock Footage Finder"
        }
        
        data = {
            "model": self.settings.embedding_model,
            "input": texts
        }
        
        url = f"{self.settings.openrouter_base_url}/embeddings"
        response = await self.client.post(url, headers=headers, json=data)
        response.raise_for_status()
        
        result = response.json()
        if "data" not in result or not result["data"]:
            raise ValueError("Invalid response from embedding API")
        
        # Extract embeddings in the same order as input texts
        embeddings = []
        for item in result["data"]:
            embeddings.append(item["embedding"])
        
        return embeddings
    
    def get_usage_stats(self, db: Session) -> Dict[str, Any]:
        """Get usage statistics for the embedding service."""
        now = datetime.utcnow()
        
        # Get current period usage
        hour_start = now.replace(minute=0, second=0, microsecond=0)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        
        hourly_usage = db.query(EmbeddingUsage).filter(
            EmbeddingUsage.period_type == 'hour',
            EmbeddingUsage.period_start == hour_start
        ).first()
        
        daily_usage = db.query(EmbeddingUsage).filter(
            EmbeddingUsage.period_type == 'day',
            EmbeddingUsage.period_start == day_start
        ).first()
        
        # Calculate cache hit rate
        total_cache_entries = db.query(EmbeddingCache).count()
        active_cache_entries = db.query(EmbeddingCache).filter(
            EmbeddingCache.is_active == True,
            EmbeddingCache.expires_at > now
        ).count()
        
        cache_hit_rate = 0
        if total_cache_entries > 0:
            total_hits = db.query(EmbeddingCache).with_entities(
                db.func.sum(EmbeddingCache.hit_count)
            ).scalar() or 0
            cache_hit_rate = (total_hits / total_cache_entries) * 100
        
        return {
            "model": self.settings.embedding_model,
            "dimension": self.settings.embedding_dimension,
            "requests_this_hour": hourly_usage.requests_count if hourly_usage else 0,
            "requests_today": daily_usage.requests_count if daily_usage else 0,
            "tokens_this_hour": hourly_usage.tokens_used if hourly_usage else 0,
            "tokens_today": daily_usage.tokens_used if daily_usage else 0,
            "texts_this_hour": hourly_usage.texts_processed if hourly_usage else 0,
            "texts_today": daily_usage.texts_processed if daily_usage else 0,
            "cache_hit_rate": cache_hit_rate,
            "total_cache_entries": total_cache_entries,
            "active_cache_entries": active_cache_entries,
            "quota_limit": self.settings.embedding_quota_limit
        }
    
    def clear_cache(self, db: Session, older_than_hours: int = 24) -> int:
        """Clear expired or old cache entries."""
        cutoff_time = datetime.utcnow() - timedelta(hours=older_than_hours)
        
        # Delete expired cache entries
        deleted_count = db.query(EmbeddingCache).filter(
            EmbeddingCache.expires_at < cutoff_time
        ).delete()
        
        # Mark expired text embeddings
        db.query(TextEmbedding).filter(
            TextEmbedding.cache_expires_at < cutoff_time
        ).update({"is_cached": False})
        
        db.commit()
        return deleted_count


# Global instance
embedding_client = EmbeddingClient()