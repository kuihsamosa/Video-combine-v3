import httpx
import asyncio
from typing import Dict, List, Optional, Any, Union, Tuple
from datetime import datetime
from tenacity import retry, stop_after_attempt, wait_exponential
from sqlalchemy.orm import Session

from config import get_settings, get_media_source_config
from services.api_key_manager import api_key_manager
from services.media_types import MediaItem


class StockMediaService:
    """Service for searching stock media across multiple sources."""
    
    def __init__(self):
        self.settings = get_settings()
        self.client = httpx.AsyncClient(timeout=30.0)
    
    async def __aenter__(self):
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.client.aclose()
    
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    async def _make_request(self, method: str, url: str, headers: Optional[Dict] = None, params: Optional[Dict] = None) -> Dict:
        """Make HTTP request with retry logic."""
        response = await self.client.request(method, url, headers=headers, params=params)
        response.raise_for_status()
        return response.json()
    
    async def search_pexels(self, query: str, per_page: int = 20, page: int = 1) -> List[MediaItem]:
        """Search for videos on Pexels."""
        source_config = get_media_source_config("pexels")
        api_key = api_key_manager.get_api_key("pexels")
        
        if not api_key:
            return []
        
        if api_key_manager.is_rate_limited_legacy("pexels"):
            return []
        
        try:
            headers = {"Authorization": api_key}
            params = {
                "query": query,
                "per_page": min(per_page, self.settings.max_per_page),
                "page": page
            }
            
            url = f"{source_config['base_url']}{source_config['search_endpoint']}"
            response = await self._make_request("GET", url, headers=headers, params=params)
            
            api_key_manager.track_api_usage("pexels")
            
            media_items = []
            for video in response.get("videos", []):
                # Get the best quality video file
                video_files = video.get("video_files", [])
                best_file = max(video_files, key=lambda x: x.get("width", 0) * x.get("height", 0)) if video_files else None
                
                if best_file:
                    media_item = MediaItem(
                        id=str(video.get("id")),
                        title=video.get("url", "").split("/")[-1] or f"Pexels Video {video.get('id')}",
                        description=video.get("description") or video.get("alt", ""),
                        url=best_file.get("link", ""),
                        preview_url=video.get("image", ""),
                        download_url=best_file.get("link", ""),
                        duration=video.get("duration"),
                        width=best_file.get("width"),
                        height=best_file.get("height"),
                        tags=[tag.strip() for tag in video.get("tags", [])] if video.get("tags") else [],
                        source="pexels",
                        author=video.get("user", {}).get("name"),
                        author_url=video.get("user", {}).get("url"),
                        media_type="video"
                    )
                    media_items.append(media_item)
            
            return media_items
        
        except Exception as e:
            print(f"Error searching Pexels: {e}")
            return []
    
    async def search_pixabay(self, query: str, per_page: int = 20, page: int = 1, media_type: str = "video") -> List[MediaItem]:
        """Search for videos or images on Pixabay."""
        source_config = get_media_source_config("pixabay")
        api_key = api_key_manager.get_api_key("pixabay")
        
        if not api_key:
            return []
        
        if api_key_manager.is_rate_limited_legacy("pixabay"):
            return []
        
        try:
            endpoint = source_config["video_endpoint"] if media_type == "video" else source_config["image_endpoint"]
            params = {
                "key": api_key,
                "q": query,
                "per_page": min(per_page, self.settings.max_per_page),
                "page": page,
                "safesearch": "true"
            }
            
            if media_type == "video":
                params.update(source_config.get("search_params", {}))
            
            url = f"{source_config['base_url']}{endpoint}"
            response = await self._make_request("GET", url, params=params)
            
            api_key_manager.track_api_usage("pixabay")
            
            media_items = []
            items_key = "hits"  # Pixabay uses "hits" for results
            
            for item in response.get(items_key, []):
                if media_type == "video":
                    # Get the best quality video
                    videos = item.get("videos", {})
                    best_video = None
                    
                    # Try different quality options
                    for quality in ["large", "medium", "small", "tiny"]:
                        if quality in videos and videos[quality]:
                            best_video = videos[quality]
                            break
                    
                    if best_video:
                        media_item = MediaItem(
                            id=str(item.get("id")),
                            title=item.get("tags", "").split(",")[0] if item.get("tags") else f"Pixabay Video {item.get('id')}",
                            description=item.get("tags", ""),
                            url=best_video.get("url", ""),
                            preview_url=item.get("previewURL", ""),
                            download_url=best_video.get("url", ""),
                            duration=item.get("duration"),
                            width=item.get("width"),
                            height=item.get("height"),
                            file_size=item.get("videos", {}).get("large", {}).get("size"),
                            tags=[tag.strip() for tag in item.get("tags", "").split(",")] if item.get("tags") else [],
                            source="pixabay",
                            author=item.get("user"),
                            author_url=f"https://pixabay.com/users/{item.get('user')}-{item.get('user_id')}/",
                            media_type="video"
                        )
                        media_items.append(media_item)
                else:  # image
                    media_item = MediaItem(
                        id=str(item.get("id")),
                        title=item.get("tags", "").split(",")[0] if item.get("tags") else f"Pixabay Image {item.get('id')}",
                        description=item.get("tags", ""),
                        url=item.get("webformatURL", ""),
                        preview_url=item.get("previewURL", ""),
                        download_url=item.get("largeImageURL", ""),
                        width=item.get("imageWidth"),
                        height=item.get("imageHeight"),
                        file_size=item.get("imageSize"),
                        tags=[tag.strip() for tag in item.get("tags", "").split(",")] if item.get("tags") else [],
                        source="pixabay",
                        author=item.get("user"),
                        author_url=f"https://pixabay.com/users/{item.get('user')}-{item.get('user_id')}/",
                        media_type="image"
                    )
                    media_items.append(media_item)
            
            return media_items
        
        except Exception as e:
            print(f"Error searching Pixabay: {e}")
            return []
    
    async def search_unsplash(self, query: str, per_page: int = 20, page: int = 1, media_type: str = "photo") -> List[MediaItem]:
        """Search for photos or videos on Unsplash."""
        source_config = get_media_source_config("unsplash")
        api_key = api_key_manager.get_api_key("unsplash")
        
        if not api_key:
            return []
        
        if api_key_manager.is_rate_limited_legacy("unsplash"):
            return []
        
        try:
            headers = {
                "Authorization": f"Client-ID {api_key}",
                "Accept-Version": "v1"
            }
            
            endpoint = source_config["video_search_endpoint"] if media_type == "video" else source_config["search_endpoint"]
            params = {
                "query": query,
                "per_page": min(per_page, self.settings.max_per_page),
                "page": page
            }
            
            url = f"{source_config['base_url']}{endpoint}"
            response = await self._make_request("GET", url, headers=headers, params=params)
            
            api_key_manager.track_api_usage("unsplash")
            
            media_items = []
            results_key = "results"
            
            for item in response.get(results_key, []):
                if media_type == "video":
                    # Get the best quality video
                    video_files = item.get("video_files", [])
                    best_video = max(video_files, key=lambda x: x.get("width", 0) * x.get("height", 0)) if video_files else None
                    
                    if best_video:
                        media_item = MediaItem(
                            id=item.get("id"),
                            title=item.get("description") or item.get("alt_description") or f"Unsplash Video {item.get('id')}",
                            description=item.get("description") or item.get("alt_description"),
                            url=best_video.get("link", ""),
                            preview_url=item.get("urls", {}).get("regular", ""),
                            download_url=best_video.get("link", ""),
                            duration=item.get("duration"),
                            width=best_video.get("width"),
                            height=best_video.get("height"),
                            tags=[tag.get("title") for tag in item.get("tags", [])] if item.get("tags") else [],
                            source="unsplash",
                            author=item.get("user", {}).get("name"),
                            author_url=item.get("user", {}).get("links", {}).get("html"),
                            media_type="video"
                        )
                        media_items.append(media_item)
                else:  # photo
                    media_item = MediaItem(
                        id=item.get("id"),
                        title=item.get("description") or item.get("alt_description") or f"Unsplash Photo {item.get('id')}",
                        description=item.get("description") or item.get("alt_description"),
                        url=item.get("urls", {}).get("regular", ""),
                        preview_url=item.get("urls", {}).get("small", ""),
                        download_url=item.get("urls", {}).get("full", ""),
                        width=item.get("width"),
                        height=item.get("height"),
                        tags=[tag.get("title") for tag in item.get("tags", [])] if item.get("tags") else [],
                        source="unsplash",
                        author=item.get("user", {}).get("name"),
                        author_url=item.get("user", {}).get("links", {}).get("html"),
                        media_type="image"
                    )
                    media_items.append(media_item)
            
            return media_items
        
        except Exception as e:
            print(f"Error searching Unsplash: {e}")
            return []
    
    async def search_videvo(self, query: str, per_page: int = 20, page: int = 1) -> List[MediaItem]:
        """Search for videos on Videvo."""
        source_config = get_media_source_config("videvo")
        api_key = api_key_manager.get_api_key("videvo")
        
        if not api_key:
            return []
        
        if api_key_manager.is_rate_limited_legacy("videvo"):
            return []
        
        try:
            headers = {"Authorization": f"Bearer {api_key}"}
            params = {
                "q": query,
                "limit": min(per_page, self.settings.max_per_page),
                "offset": (page - 1) * per_page
            }
            
            url = f"{source_config['base_url']}{source_config['search_endpoint']}"
            response = await self._make_request("GET", url, headers=headers, params=params)
            
            api_key_manager.track_api_usage("videvo")
            
            media_items = []
            results_key = "results"  # Adjust based on actual API response
            
            for item in response.get(results_key, []):
                # This is a placeholder implementation
                # Adjust based on actual Videvo API response structure
                media_item = MediaItem(
                    id=str(item.get("id")),
                    title=item.get("title", f"Videvo Video {item.get('id')}"),
                    description=item.get("description"),
                    url=item.get("url", ""),
                    preview_url=item.get("thumbnail", ""),
                    download_url=item.get("download_url", ""),
                    duration=item.get("duration"),
                    width=item.get("width"),
                    height=item.get("height"),
                    tags=item.get("tags", []),
                    source="videvo",
                    author=item.get("author"),
                    author_url=item.get("author_url"),
                    media_type="video"
                )
                media_items.append(media_item)
            
            return media_items
        
        except Exception as e:
            print(f"Error searching Videvo: {e}")
            return []
    
    async def search_coverr(self, query: str, per_page: int = 20, page: int = 1) -> List[MediaItem]:
        """Search for videos on Coverr."""
        source_config = get_media_source_config("coverr")
        
        # Coverr doesn't require an API key
        if api_key_manager.is_rate_limited_legacy("coverr"):
            return []
        
        try:
            params = {
                "q": query,
                "limit": min(per_page, self.settings.max_per_page),
                "offset": (page - 1) * per_page
            }
            
            url = f"{source_config['base_url']}{source_config['search_endpoint']}"
            response = await self._make_request("GET", url, params=params)
            
            api_key_manager.track_api_usage("coverr")
            
            media_items = []
            results_key = "results"  # Adjust based on actual API response
            
            for item in response.get(results_key, []):
                # This is a placeholder implementation
                # Adjust based on actual Coverr API response structure
                media_item = MediaItem(
                    id=str(item.get("id")),
                    title=item.get("title", f"Coverr Video {item.get('id')}"),
                    description=item.get("description"),
                    url=item.get("url", ""),
                    preview_url=item.get("thumbnail", ""),
                    download_url=item.get("download_url", ""),
                    duration=item.get("duration"),
                    width=item.get("width"),
                    height=item.get("height"),
                    tags=item.get("tags", []),
                    source="coverr",
                    author=item.get("author"),
                    author_url=item.get("author_url"),
                    media_type="video"
                )
                media_items.append(media_item)
            
            return media_items
        
        except Exception as e:
            print(f"Error searching Coverr: {e}")
            return []
    
    async def search_all_sources(
        self,
        query: str,
        sources: Optional[List[str]] = None,
        per_page: int = 20,
        page: int = 1,
        media_type: str = "video"
    ) -> Dict[str, List[MediaItem]]:
        """Search across multiple sources concurrently."""
        if not sources:
            sources = self.settings.default_sources
        
        search_tasks = []
        source_names = []
        
        for source in sources:
            if source == "pexels":
                search_tasks.append(self.search_pexels(query, per_page, page))
                source_names.append("pexels")
            elif source == "pixabay":
                search_tasks.append(self.search_pixabay(query, per_page, page, media_type))
                source_names.append("pixabay")
            elif source == "unsplash":
                search_tasks.append(self.search_unsplash(query, per_page, page, media_type))
                source_names.append("unsplash")
            elif source == "videvo":
                search_tasks.append(self.search_videvo(query, per_page, page))
                source_names.append("videvo")
            elif source == "coverr":
                search_tasks.append(self.search_coverr(query, per_page, page))
                source_names.append("coverr")
        
        # Execute all searches concurrently
        results = await asyncio.gather(*search_tasks, return_exceptions=True)
        
        # Combine results
        combined_results = {}
        for i, result in enumerate(results):
            source_name = source_names[i]
            if isinstance(result, Exception):
                print(f"Error searching {source_name}: {result}")
                combined_results[source_name] = []
            else:
                combined_results[source_name] = result
        
        return combined_results
    
    async def search_with_semantic_matching(
        self,
        query: str,
        db: Session,
        sources: Optional[List[str]] = None,
        per_page: int = 20,
        page: int = 1,
        media_type: str = "video",
        min_relevance_score: float = 0.1,
        use_semantic_search: bool = True,
        fallback_to_keyword_search: bool = True
    ) -> Dict[str, List[MediaItem]]:
        """
        Search across multiple sources with semantic matching and relevance scoring.
        
        Args:
            query: Search query
            db: Database session
            sources: List of sources to search (optional)
            per_page: Number of results per page
            page: Page number
            media_type: Type of media to search for
            min_relevance_score: Minimum relevance score threshold
            use_semantic_search: Whether to use semantic matching
            fallback_to_keyword_search: Whether to fallback to keyword search
            
        Returns:
            Dictionary with source names as keys and lists of scored media items as values
        """
        # First, get traditional search results
        traditional_results = await self.search_all_sources(
            query=query,
            sources=sources,
            per_page=per_page * 2,  # Get more results for better matching
            page=page,
            media_type=media_type
        )
        
        # Flatten all media items
        all_media_items = []
        for source_items in traditional_results.values():
            all_media_items.extend(source_items)
        
        if not all_media_items:
            return traditional_results
        
        # Apply semantic matching if requested
        if use_semantic_search:
            try:
                scored_results = await matching_service.find_similar_media(
                    query=query,
                    media_items=all_media_items,
                    db=db,
                    min_score=min_relevance_score,
                    max_results=per_page * len(traditional_results) if traditional_results else per_page,
                    use_embeddings=True,
                    fallback_to_keywords=fallback_to_keyword_search
                )
                
                # Group scored results by source
                scored_by_source = {}
                for media_item, score, component_scores in scored_results:
                    source = media_item.source
                    if source not in scored_by_source:
                        scored_by_source[source] = []
                    
                    # Update media item with relevance score
                    media_item.relevance_score = score
                    media_item.component_scores = component_scores
                    
                    scored_by_source[source].append(media_item)
                
                return scored_by_source
                
            except Exception as e:
                print(f"Semantic matching failed: {e}")
                
                # Fallback to traditional results with basic relevance scoring
                if fallback_to_keyword_search:
                    return self._apply_keyword_scoring(traditional_results, query)
        
        # Return traditional results if semantic search is disabled
        return traditional_results
    
    def _apply_keyword_scoring(
        self, 
        results: Dict[str, List[MediaItem]], 
        query: str
    ) -> Dict[str, List[MediaItem]]:
        """
        Apply basic keyword-based relevance scoring to traditional search results.
        
        Args:
            results: Traditional search results by source
            query: Search query
            
        Returns:
            Results with basic relevance scoring applied
        """
        query_lower = query.lower()
        query_terms = query_lower.split()
        
        scored_results = {}
        
        for source, media_items in results.items():
            scored_items = []
            
            for media_item in media_items:
                score = 0.0
                
                # Check title match
                if media_item.title:
                    title_lower = media_item.title.lower()
                    if query_lower in title_lower:
                        score += 0.5
                    
                    # Check individual term matches in title
                    for term in query_terms:
                        if term in title_lower:
                            score += 0.1
                
                # Check description match
                if media_item.description:
                    desc_lower = media_item.description.lower()
                    if query_lower in desc_lower:
                        score += 0.3
                    
                    # Check individual term matches in description
                    for term in query_terms:
                        if term in desc_lower:
                            score += 0.05
                
                # Check tag matches
                if media_item.tags:
                    tag_matches = 0
                    for tag in media_item.tags:
                        tag_lower = tag.lower()
                        if query_lower in tag_lower:
                            score += 0.2
                            tag_matches += 1
                        
                        # Check individual term matches in tags
                        for term in query_terms:
                            if term in tag_lower:
                                score += 0.05
                    
                    # Bonus for multiple tag matches
                    if tag_matches > 1:
                        score += 0.1 * (tag_matches - 1)
                
                # Normalize score to 0-1 range
                score = min(1.0, score)
                
                # Update media item with relevance score
                media_item.relevance_score = score
                media_item.component_scores = {"keyword": score}
                
                scored_items.append(media_item)
            
            # Sort by relevance score (descending)
            scored_items.sort(key=lambda x: x.relevance_score, reverse=True)
            scored_results[source] = scored_items
        
        return scored_results
    
    async def find_related_media(
        self,
        media_item: MediaItem,
        db: Session,
        sources: Optional[List[str]] = None,
        max_results: int = 10,
        min_similarity_score: float = 0.2
    ) -> List[MediaItem]:
        """
        Find media items related to a given media item.
        
        Args:
            media_item: Reference media item
            db: Database session
            sources: Sources to search in (optional)
            max_results: Maximum number of related items to return
            min_similarity_score: Minimum similarity score threshold
            
        Returns:
            List of related media items with relevance scores
        """
        # Get more media items from same or similar sources
        search_sources = sources or [media_item.source]
        
        # Use a generic query based on media item's content
        query_text = media_item.title or ""
        if media_item.description:
            query_text += " " + media_item.description
        if media_item.tags:
            query_text += " " + " ".join(media_item.tags)
        
        # Search for related content
        related_results = await self.search_all_sources(
            query=query_text,
            sources=search_sources,
            per_page=max_results * 3,  # Get more for better matching
            page=1,
            media_type=media_item.media_type
        )
        
        # Flatten all media items
        all_media_items = []
        for source_items in related_results.values():
            all_media_items.extend(source_items)
        
        if not all_media_items:
            return []
        
        # Use matching service to find similar items
        try:
            similar_items = await matching_service.find_related_media(
                media_item=media_item,
                all_media_items=all_media_items,
                db=db,
                min_score=min_similarity_score,
                max_results=max_results
            )
            
            # Extract just media items with scores
            result_items = []
            for related_item, score, component_scores in similar_items:
                related_item.relevance_score = score
                related_item.component_scores = component_scores
                result_items.append(related_item)
            
            return result_items
            
        except Exception as e:
            print(f"Error finding related media: {e}")
            return []
    
    async def get_popular_media(self, source: str, per_page: int = 20, page: int = 1) -> List[MediaItem]:
        """Get popular media from a specific source."""
        # This is a placeholder implementation
        # Actual implementation would depend on each source's API for popular content
        return []