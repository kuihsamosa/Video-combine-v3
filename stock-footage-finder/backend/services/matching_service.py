"""
Semantic matching service for finding relevant media based on text embeddings.
Uses cosine similarity and fallback keyword matching for robust search.
"""

import re
from typing import Dict, List, Optional, Tuple, Any, Union
from datetime import datetime

import numpy as np
from sqlalchemy.orm import Session
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import linear_kernel

from config import get_settings
from services.embedding_client import embedding_client
from services.media_types import MediaItem
from models.embeddings import MediaEmbedding, TextEmbedding


class MatchingService:
    """
    Service for semantic matching between queries and media items.
    """
    
    def __init__(self):
        self.settings = get_settings()
        self._tfidf_vectorizer = None
        self._media_embeddings_cache = {}
        self._last_cache_update = None
        self._cache_ttl_minutes = 30  # Cache media embeddings for 30 minutes
    
    def _get_media_text(self, media_item: MediaItem) -> str:
        """Extract searchable text from a media item."""
        text_parts = []
        
        if media_item.title:
            text_parts.append(media_item.title)
        
        if media_item.description:
            text_parts.append(media_item.description)
        
        if media_item.tags:
            text_parts.extend(media_item.tags)
        
        return " ".join(text_parts).strip()
    
    def _clean_text(self, text: str) -> str:
        """Clean and normalize text for processing."""
        if not text:
            return ""
        
        # Convert to lowercase
        text = text.lower()
        
        # Remove special characters but keep spaces
        text = re.sub(r'[^\w\s]', ' ', text)
        
        # Remove extra whitespace
        text = re.sub(r'\s+', ' ', text).strip()
        
        return text
    
    def _extract_keywords(self, text: str) -> List[str]:
        """Extract keywords from text using simple heuristics."""
        if not text:
            return []
        
        # Clean text
        text = self._clean_text(text)
        
        # Split into words and filter out common stop words
        words = text.split()
        
        # Simple stop words list
        stop_words = {
            'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
            'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
            'to', 'was', 'will', 'with', 'the', 'this', 'but', 'they', 'have',
            'had', 'what', 'said', 'each', 'which', 'their', 'time', 'if'
        }
        
        keywords = [word for word in words if len(word) > 2 and word not in stop_words]
        
        return keywords
    
    def _keyword_match_score(self, query: str, media_text: str) -> float:
        """Calculate keyword matching score between query and media text."""
        query_keywords = set(self._extract_keywords(query))
        media_keywords = set(self._extract_keywords(media_text))
        
        if not query_keywords:
            return 0.0
        
        if not media_keywords:
            return 0.0
        
        # Calculate Jaccard similarity
        intersection = query_keywords.intersection(media_keywords)
        union = query_keywords.union(media_keywords)
        
        if not union:
            return 0.0
        
        return len(intersection) / len(union)
    
    def _tfidf_similarity(self, query: str, media_texts: List[str]) -> List[float]:
        """Calculate TF-IDF similarity between query and multiple media texts."""
        if not query or not media_texts:
            return [0.0] * len(media_texts)
        
        # Initialize or update TF-IDF vectorizer
        if self._tfidf_vectorizer is None:
            self._tfidf_vectorizer = TfidfVectorizer(
                stop_words='english',
                max_features=5000,
                ngram_range=(1, 2)
            )
        
        # Fit vectorizer on all texts
        all_texts = [query] + media_texts
        tfidf_matrix = self._tfidf_vectorizer.fit_transform(all_texts)
        
        # Calculate cosine similarity between query and each media text
        query_vector = tfidf_matrix[0:1]
        media_vectors = tfidf_matrix[1:]
        
        similarities = linear_kernel(query_vector, media_vectors).flatten()
        
        return similarities.tolist()
    
    async def _get_media_embedding(self, media_item: MediaItem, db: Session) -> Optional[np.ndarray]:
        """Get or create embedding for a media item."""
        media_text = self._get_media_text(media_item)
        
        if not media_text:
            return None
        
        # Check cache first
        cache_key = f"{media_item.source}:{media_item.id}"
        if cache_key in self._media_embeddings_cache:
            cached_entry = self._media_embeddings_cache[cache_key]
            if (datetime.utcnow() - cached_entry['timestamp']).total_seconds() < self._cache_ttl_minutes * 60:
                return cached_entry['embedding']
        
        # Check database
        media_embedding = db.query(MediaEmbedding).filter(
            MediaEmbedding.media_id == media_item.id,
            MediaEmbedding.media_source == media_item.source,
            MediaEmbedding.embedding_model == self.settings.embedding_model
        ).first()
        
        if media_embedding:
            embedding = media_embedding.get_embedding_vector()
            
            # Update cache
            self._media_embeddings_cache[cache_key] = {
                'embedding': embedding,
                'timestamp': datetime.utcnow()
            }
            
            return embedding
        
        # Generate new embedding
        try:
            async with embedding_client:
                embedding = await embedding_client.get_embedding(
                    text=media_text,
                    db=db,
                    source=f"media:{media_item.source}",
                    metadata={
                        "media_id": media_item.id,
                        "media_source": media_item.source,
                        "media_type": media_item.media_type,
                        "title": media_item.title,
                        "tags": media_item.tags
                    },
                    use_cache=True
                )
            
            # Store in database
            media_embedding = MediaEmbedding(
                media_id=media_item.id,
                media_source=media_item.source,
                media_type=media_item.media_type,
                title=media_item.title,
                description=media_item.description,
                tags=str(media_item.tags) if media_item.tags else None,
                combined_text=media_text,
                embedding_model=self.settings.embedding_model
            )
            media_embedding.set_embedding_vector(embedding)
            
            db.add(media_embedding)
            db.commit()
            
            # Update cache
            self._media_embeddings_cache[cache_key] = {
                'embedding': embedding,
                'timestamp': datetime.utcnow()
            }
            
            return embedding
            
        except Exception as e:
            print(f"Error generating embedding for media {media_item.id}: {e}")
            return None
    
    async def calculate_semantic_similarity(
        self,
        query: str,
        media_items: List[MediaItem],
        db: Session,
        use_embeddings: bool = True,
        use_keywords: bool = True,
        use_tfidf: bool = True
    ) -> List[Tuple[MediaItem, float, Dict[str, float]]]:
        """
        Calculate similarity scores between query and media items.
        
        Args:
            query: Search query
            media_items: List of media items to score
            db: Database session
            use_embeddings: Whether to use semantic embeddings
            use_keywords: Whether to use keyword matching
            use_tfidf: Whether to use TF-IDF similarity
            
        Returns:
            List of tuples: (media_item, total_score, component_scores)
        """
        if not query or not media_items:
            return []
        
        results = []
        
        # Get query embedding if needed
        query_embedding = None
        if use_embeddings:
            try:
                async with embedding_client:
                    query_embedding = await embedding_client.get_embedding(
                        text=query,
                        db=db,
                        source="search_query",
                        metadata={"type": "search_query"},
                        use_cache=True
                    )
            except Exception as e:
                print(f"Error generating query embedding: {e}")
                use_embeddings = False
        
        # Get media embeddings if needed
        media_embeddings = []
        if use_embeddings and query_embedding is not None:
            for media_item in media_items:
                embedding = await self._get_media_embedding(media_item, db)
                media_embeddings.append(embedding)
        else:
            media_embeddings = [None] * len(media_items)
        
        # Calculate TF-IDF similarities if needed
        tfidf_similarities = []
        if use_tfidf:
            media_texts = [self._get_media_text(item) for item in media_items]
            tfidf_similarities = self._tfidf_similarity(query, media_texts)
        else:
            tfidf_similarities = [0.0] * len(media_items)
        
        # Calculate scores for each media item
        for i, media_item in enumerate(media_items):
            component_scores = {}
            total_score = 0.0
            
            # Semantic similarity (cosine similarity)
            if use_embeddings and query_embedding is not None and media_embeddings[i] is not None:
                semantic_sim = cosine_similarity(
                    query_embedding.reshape(1, -1),
                    media_embeddings[i].reshape(1, -1)
                )[0][0]
                component_scores['semantic'] = float(semantic_sim)
                total_score += semantic_sim * 0.6  # Weight: 60%
            
            # Keyword matching
            if use_keywords:
                media_text = self._get_media_text(media_item)
                keyword_sim = self._keyword_match_score(query, media_text)
                component_scores['keyword'] = float(keyword_sim)
                total_score += keyword_sim * 0.2  # Weight: 20%
            
            # TF-IDF similarity
            if use_tfidf:
                tfidf_sim = tfidf_similarities[i]
                component_scores['tfidf'] = float(tfidf_sim)
                total_score += tfidf_sim * 0.2  # Weight: 20%
            
            # Normalize score to 0-1 range
            total_score = max(0.0, min(1.0, total_score))
            
            results.append((media_item, total_score, component_scores))
        
        # Sort by score (descending)
        results.sort(key=lambda x: x[1], reverse=True)
        
        return results
    
    async def find_similar_media(
        self,
        query: str,
        media_items: List[MediaItem],
        db: Session,
        min_score: float = 0.1,
        max_results: int = 50,
        use_embeddings: bool = True,
        fallback_to_keywords: bool = True
    ) -> List[Tuple[MediaItem, float, Dict[str, float]]]:
        """
        Find media items similar to the query with fallback mechanisms.
        
        Args:
            query: Search query
            media_items: List of media items to search through
            db: Database session
            min_score: Minimum similarity score threshold
            max_results: Maximum number of results to return
            use_embeddings: Whether to use semantic embeddings
            fallback_to_keywords: Whether to fallback to keyword matching if embeddings fail
            
        Returns:
            List of tuples: (media_item, score, component_scores)
        """
        if not query or not media_items:
            return []
        
        # Try semantic matching first
        if use_embeddings:
            try:
                results = await self.calculate_semantic_similarity(
                    query=query,
                    media_items=media_items,
                    db=db,
                    use_embeddings=True,
                    use_keywords=True,
                    use_tfidf=True
                )
                
                # Filter by minimum score
                filtered_results = [
                    (item, score, components) for item, score, components in results
                    if score >= min_score
                ]
                
                if filtered_results:
                    return filtered_results[:max_results]
                
            except Exception as e:
                print(f"Semantic matching failed: {e}")
        
        # Fallback to keyword matching
        if fallback_to_keywords:
            try:
                results = await self.calculate_semantic_similarity(
                    query=query,
                    media_items=media_items,
                    db=db,
                    use_embeddings=False,
                    use_keywords=True,
                    use_tfidf=True
                )
                
                # Filter by minimum score (lower threshold for keyword-only matching)
                filtered_results = [
                    (item, score, components) for item, score, components in results
                    if score >= max(0.05, min_score * 0.5)
                ]
                
                return filtered_results[:max_results]
                
            except Exception as e:
                print(f"Keyword matching failed: {e}")
        
        # Last resort: return empty results
        return []
    
    async def find_related_media(
        self,
        media_item: MediaItem,
        all_media_items: List[MediaItem],
        db: Session,
        min_score: float = 0.2,
        max_results: int = 10
    ) -> List[Tuple[MediaItem, float, Dict[str, float]]]:
        """
        Find media items related to a given media item.
        
        Args:
            media_item: The reference media item
            all_media_items: List of all media items to search through
            db: Database session
            min_score: Minimum similarity score threshold
            max_results: Maximum number of results to return
            
        Returns:
            List of tuples: (media_item, score, component_scores)
        """
        # Use the media item's text as the query
        query_text = self._get_media_text(media_item)
        
        if not query_text:
            return []
        
        # Remove the reference item from the search results
        other_items = [
            item for item in all_media_items
            if not (item.id == media_item.id and item.source == media_item.source)
        ]
        
        return await self.find_similar_media(
            query=query_text,
            media_items=other_items,
            db=db,
            min_score=min_score,
            max_results=max_results,
            use_embeddings=True,
            fallback_to_keywords=True
        )
    
    def clear_cache(self):
        """Clear the in-memory media embeddings cache."""
        self._media_embeddings_cache.clear()
        self._last_cache_update = None
        self._tfidf_vectorizer = None
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get statistics about the in-memory cache."""
        return {
            "cached_media_items": len(self._media_embeddings_cache),
            "last_cache_update": self._last_cache_update.isoformat() if self._last_cache_update else None,
            "cache_ttl_minutes": self._cache_ttl_minutes,
            "tfidf_vectorizer_initialized": self._tfidf_vectorizer is not None
        }


# Global instance
matching_service = MatchingService()