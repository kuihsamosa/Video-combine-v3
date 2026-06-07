"""
API endpoints for text embeddings and similarity calculations.
"""

from typing import Dict, List, Optional, Any
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from services.embedding_client import embedding_client
from models.embeddings import TextEmbedding, EmbeddingSimilarity, EmbeddingCache

router = APIRouter(prefix="/api/embeddings", tags=["embeddings"])


# Request/Response Models
class TextEmbeddingRequest(BaseModel):
    text: str = Field(..., description="Text to generate embedding for", min_length=1)
    source: Optional[str] = Field(None, description="Source of the text")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional metadata")
    use_cache: Optional[bool] = Field(True, description="Whether to use cached embeddings")


class BatchEmbeddingRequest(BaseModel):
    texts: List[str] = Field(..., description="List of texts to generate embeddings for", min_items=1)
    source: Optional[str] = Field(None, description="Source of the texts")
    metadata_list: Optional[List[Dict[str, Any]]] = Field(None, description="List of metadata for each text")
    use_cache: Optional[bool] = Field(True, description="Whether to use cached embeddings")


class SimilarityRequest(BaseModel):
    text1: str = Field(..., description="First text for comparison", min_length=1)
    text2: str = Field(..., description="Second text for comparison", min_length=1)
    context: Optional[str] = Field(None, description="Context for the similarity calculation")
    store_result: Optional[bool] = Field(True, description="Whether to store the similarity result")


class EmbeddingResponse(BaseModel):
    text: str
    embedding: List[float]
    dimension: int
    model: str
    cached: bool


class BatchEmbeddingResponse(BaseModel):
    results: List[EmbeddingResponse]
    total_processed: int
    cached_count: int


class SimilarityResponse(BaseModel):
    text1: str
    text2: str
    cosine_similarity: float
    euclidean_distance: Optional[float] = None
    dot_product: Optional[float] = None
    context: Optional[str] = None


class CacheStatsResponse(BaseModel):
    total_entries: int
    active_entries: int
    expired_entries: int
    hit_rate: float
    total_hits: int


class UsageStatsResponse(BaseModel):
    model: str
    dimension: int
    requests_this_hour: int
    requests_today: int
    tokens_this_hour: int
    tokens_today: int
    texts_this_hour: int
    texts_today: int
    cache_hit_rate: float
    total_cache_entries: int
    active_cache_entries: int
    quota_limit: int


class ClearCacheRequest(BaseModel):
    older_than_hours: Optional[int] = Field(24, description="Clear cache entries older than this many hours")


@router.post("/text", response_model=EmbeddingResponse)
async def generate_text_embedding(
    request: TextEmbeddingRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """
    Generate embedding for a single text.
    
    Args:
        request: Text embedding request
        background_tasks: FastAPI background tasks
        db: Database session
        
    Returns:
        Embedding response with vector and metadata
    """
    try:
        async with embedding_client:
            embedding = await embedding_client.get_embedding(
                text=request.text,
                db=db,
                source=request.source,
                metadata=request.metadata,
                use_cache=request.use_cache
            )
            
            # Check if this was a cache hit
            text_hash = embedding_client._get_text_hash(request.text)
            cache_key = embedding_client._get_cache_key(request.text, embedding_client.settings.embedding_model)
            cached_embedding = embedding_client._get_cached_embedding(db, cache_key, text_hash)
            is_cached = cached_embedding is not None
            
            return EmbeddingResponse(
                text=request.text,
                embedding=embedding.tolist(),
                dimension=len(embedding),
                model=embedding_client.settings.embedding_model,
                cached=is_cached
            )
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate embedding: {str(e)}")


@router.post("/batch", response_model=BatchEmbeddingResponse)
async def generate_batch_embeddings(
    request: BatchEmbeddingRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """
    Generate embeddings for multiple texts efficiently.
    
    Args:
        request: Batch embedding request
        background_tasks: FastAPI background tasks
        db: Database session
        
    Returns:
        Batch embedding response with results and statistics
    """
    try:
        async with embedding_client:
            embeddings = await embedding_client.get_embeddings_batch(
                texts=request.texts,
                db=db,
                source=request.source,
                metadata_list=request.metadata_list,
                use_cache=request.use_cache
            )
            
            # Check which ones were cached
            cached_count = 0
            results = []
            
            for i, (text, embedding) in enumerate(zip(request.texts, embeddings)):
                if embedding is None:
                    # Empty text case
                    results.append(EmbeddingResponse(
                        text=text,
                        embedding=[],
                        dimension=0,
                        model=embedding_client.settings.embedding_model,
                        cached=False
                    ))
                else:
                    # Check if this was a cache hit
                    text_hash = embedding_client._get_text_hash(text)
                    cache_key = embedding_client._get_cache_key(text, embedding_client.settings.embedding_model)
                    cached_embedding = embedding_client._get_cached_embedding(db, cache_key, text_hash)
                    is_cached = cached_embedding is not None
                    
                    if is_cached:
                        cached_count += 1
                    
                    results.append(EmbeddingResponse(
                        text=text,
                        embedding=embedding.tolist(),
                        dimension=len(embedding),
                        model=embedding_client.settings.embedding_model,
                        cached=is_cached
                    ))
            
            return BatchEmbeddingResponse(
                results=results,
                total_processed=len(request.texts),
                cached_count=cached_count
            )
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate batch embeddings: {str(e)}")


@router.post("/similarity", response_model=SimilarityResponse)
async def calculate_similarity(
    request: SimilarityRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """
    Calculate similarity between two texts using cosine similarity.
    
    Args:
        request: Similarity calculation request
        background_tasks: FastAPI background tasks
        db: Database session
        
    Returns:
        Similarity response with various metrics
    """
    try:
        async with embedding_client:
            # Get embeddings for both texts
            embedding1 = await embedding_client.get_embedding(
                text=request.text1,
                db=db,
                use_cache=True
            )
            
            embedding2 = await embedding_client.get_embedding(
                text=request.text2,
                db=db,
                use_cache=True
            )
            
            # Calculate similarity metrics
            from sklearn.metrics.pairwise import cosine_similarity
            from scipy.spatial.distance import euclidean
            import numpy as np
            
            # Cosine similarity
            cos_sim = cosine_similarity(
                embedding1.reshape(1, -1),
                embedding2.reshape(1, -1)
            )[0][0]
            
            # Euclidean distance
            euc_dist = euclidean(embedding1, embedding2)
            
            # Dot product
            dot_prod = np.dot(embedding1, embedding2)
            
            # Store similarity result if requested
            if request.store_result:
                # Get text embeddings from database
                text_hash1 = embedding_client._get_text_hash(request.text1)
                text_hash2 = embedding_client._get_text_hash(request.text2)
                
                text_emb1 = db.query(TextEmbedding).filter(
                    TextEmbedding.text_hash == text_hash1,
                    TextEmbedding.embedding_model == embedding_client.settings.embedding_model
                ).first()
                
                text_emb2 = db.query(TextEmbedding).filter(
                    TextEmbedding.text_hash == text_hash2,
                    TextEmbedding.embedding_model == embedding_client.settings.embedding_model
                ).first()
                
                if text_emb1 and text_emb2:
                    # Check if similarity already exists
                    existing_sim = db.query(EmbeddingSimilarity).filter(
                        EmbeddingSimilarity.embedding1_id == text_emb1.id,
                        EmbeddingSimilarity.embedding2_id == text_emb2.id,
                        EmbeddingSimilarity.context == request.context
                    ).first()
                    
                    if not existing_sim:
                        similarity_record = EmbeddingSimilarity(
                            embedding1_id=text_emb1.id,
                            embedding2_id=text_emb2.id,
                            cosine_similarity=float(cos_sim),
                            euclidean_distance=float(euc_dist),
                            dot_product=float(dot_prod),
                            context=request.context
                        )
                        db.add(similarity_record)
                        db.commit()
            
            return SimilarityResponse(
                text1=request.text1,
                text2=request.text2,
                cosine_similarity=float(cos_sim),
                euclidean_distance=float(euc_dist),
                dot_product=float(dot_prod),
                context=request.context
            )
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to calculate similarity: {str(e)}")


@router.get("/cache/stats", response_model=CacheStatsResponse)
async def get_cache_stats(db: Session = Depends(get_db)):
    """
    Get statistics about the embedding cache.
    
    Args:
        db: Database session
        
    Returns:
        Cache statistics response
    """
    try:
        from datetime import datetime
        
        # Total entries
        total_entries = db.query(EmbeddingCache).count()
        
        # Active entries (not expired)
        now = datetime.utcnow()
        active_entries = db.query(EmbeddingCache).filter(
            EmbeddingCache.is_active == True,
            EmbeddingCache.expires_at > now
        ).count()
        
        # Expired entries
        expired_entries = total_entries - active_entries
        
        # Hit rate
        total_hits = db.query(EmbeddingCache).with_entities(
            db.func.sum(EmbeddingCache.hit_count)
        ).scalar() or 0
        
        hit_rate = (total_hits / total_entries * 100) if total_entries > 0 else 0
        
        return CacheStatsResponse(
            total_entries=total_entries,
            active_entries=active_entries,
            expired_entries=expired_entries,
            hit_rate=hit_rate,
            total_hits=total_hits
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get cache stats: {str(e)}")


@router.delete("/cache")
async def clear_cache(
    request: ClearCacheRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """
    Clear expired or old cache entries.
    
    Args:
        request: Cache clearing request
        background_tasks: FastAPI background tasks
        db: Database session
        
    Returns:
        Success message with count of cleared entries
    """
    try:
        deleted_count = embedding_client.clear_cache(db, request.older_than_hours)
        
        return {
            "message": f"Cleared {deleted_count} cache entries older than {request.older_than_hours} hours",
            "deleted_count": deleted_count
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear cache: {str(e)}")


@router.get("/usage/stats", response_model=UsageStatsResponse)
async def get_usage_stats(db: Session = Depends(get_db)):
    """
    Get usage statistics for the embedding service.
    
    Args:
        db: Database session
        
    Returns:
        Usage statistics response
    """
    try:
        stats = embedding_client.get_usage_stats(db)
        
        return UsageStatsResponse(**stats)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get usage stats: {str(e)}")


@router.get("/models")
async def get_available_models():
    """
    Get list of available embedding models.
    
    Returns:
        List of available models
    """
    try:
        # This could be extended to query the API for available models
        # For now, return the configured model
        return {
            "models": [
                {
                    "id": "openai/text-embedding-ada-002",
                    "name": "OpenAI Text Embedding Ada 002",
                    "dimension": 1536,
                    "description": "OpenAI's second-generation embedding model"
                },
                {
                    "id": "openai/text-embedding-3-small",
                    "name": "OpenAI Text Embedding 3 Small",
                    "dimension": 1536,
                    "description": "OpenAI's third-generation small embedding model"
                },
                {
                    "id": "openai/text-embedding-3-large",
                    "name": "OpenAI Text Embedding 3 Large",
                    "dimension": 3072,
                    "description": "OpenAI's third-generation large embedding model"
                }
            ],
            "current_model": embedding_client.settings.embedding_model
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get available models: {str(e)}")


@router.get("/health")
async def health_check():
    """
    Health check endpoint for the embedding service.
    
    Returns:
        Health status
    """
    try:
        return {
            "status": "healthy",
            "service": "embedding",
            "model": embedding_client.settings.embedding_model,
            "dimension": embedding_client.settings.embedding_dimension
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Health check failed: {str(e)}")