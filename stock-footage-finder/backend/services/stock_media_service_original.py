import httpx
import asyncio
from typing import Dict, List, Optional, Any, Union
from datetime import datetime
from tenacity import retry, stop_after_attempt, wait_exponential
from config import get_settings, get_media_source_config
from services.api_key_manager import api_key_manager


class MediaItem:
    """Standardized media item representation across all sources."""
    
    def __init__(
        self,
        id: str,
        title: str,
        url: str,
        source: str,
        description: Optional[str] = None,
        preview_url: Optional[str] = None,
        download_url: Optional[str] = None,
        duration: Optional[int] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        file_size: Optional[int] = None,
        tags: Optional[List[str]] = None,
        license: Optional[str] = None,
        author: Optional[str] = None,
        author_url: Optional[str] = None,
        media_type: str = "video"
    ):
        self.id = id
        self.title = title
        self.description = description
        self.url = url
        self.preview_url = preview_url
        self.download_url = download_url
        self.duration = duration
        self.width = width
        self.height = height
        self.file_size = file_size
        self.tags = tags or []
        self.source = source
        self.license = license
        self.author = author
        self.author_url = author_url
        self.media_type = media_type
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "url": self.url,
            "previewUrl": self.preview_url,
            "downloadUrl": self.download_url,
            "duration": self.duration,
            "width": self.width,
            "height": self.height,
            "fileSize": self.file_size,
            "tags": self.tags,
            "source": self.source,
            "license": self.license,
            "author": self.author,
            "authorUrl": self.author_url,
            "mediaType": self.media_type
        }


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
        
        if api_key_manager.is_rate_limited("pexels"):
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
        
        if api_key_manager.is_rate_limited("pixabay"):
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
        
        if api_key_manager.is_rate_limited("unsplash"):
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
        
        if api_key_manager.is_rate_limited("videvo"):
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
        if api_key_manager.is_rate_limited("coverr"):
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
    
    async def get_popular_media(self, source: str, per_page: int = 20, page: int = 1) -> List[MediaItem]:
        """Get popular media from a specific source."""
        # This is a placeholder implementation
        # Actual implementation would depend on each source's API for popular content
        return []