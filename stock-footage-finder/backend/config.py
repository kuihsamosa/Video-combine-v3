import os
from typing import Dict, List, Optional
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server Configuration
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False
    
    # API Keys
    pexels_api_key: Optional[str] = None
    pixabay_api_key: Optional[str] = None
    unsplash_api_key: Optional[str] = None
    videvo_api_key: Optional[str] = None
    coverr_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    
    # API Endpoints
    pexels_base_url: str = "https://api.pexels.com/videos"
    pixabay_base_url: str = "https://pixabay.com/api/"
    unsplash_base_url: str = "https://api.unsplash.com"
    videvo_base_url: str = "https://www.videvo.net/api"
    coverr_base_url: str = "https://api.coverr.co"
    
    # Default Settings
    default_per_page: int = 20
    max_per_page: int = 100
    default_sources: List[str] = ["pexels", "pixabay", "unsplash"]
    
    # Rate Limiting
    pexels_rate_limit: int = 200  # requests per hour
    pixabay_rate_limit: int = 100  # requests per hour
    unsplash_rate_limit: int = 50  # requests per hour
    videvo_rate_limit: int = 100  # requests per hour
    coverr_rate_limit: int = 100  # requests per hour
    
    # Retry Configuration
    max_retries: int = 3
    retry_delay: float = 1.0  # seconds
    
    # Embedding Configuration
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    embedding_model: str = "openai/text-embedding-ada-002"
    embedding_dimension: int = 1536
    embedding_cache_ttl: int = 86400  # 24 hours in seconds
    embedding_batch_size: int = 100
    embedding_quota_limit: int = 1000  # requests per day
    
    class Config:
        env_file = ".env"
        case_sensitive = False


# Media source configuration
MEDIA_SOURCES = {
    "pexels": {
        "name": "pexels",
        "display_name": "Pexels",
        "base_url": "https://api.pexels.com/videos",
        "api_key_required": True,
        "rate_limit": 200,  # requests per hour
        "search_endpoint": "/search",
        "popular_endpoint": "/popular"
    },
    "pixabay": {
        "name": "pixabay",
        "display_name": "Pixabay",
        "base_url": "https://pixabay.com/api/",
        "api_key_required": True,
        "rate_limit": 100,  # requests per hour
        "video_endpoint": "/videos/",
        "image_endpoint": "/",
        "search_params": {
            "video_type": "all",  # all, film, animation
            "category": "all",     # all, animals, nature, etc.
            "min_width": 0,
            "min_height": 0
        }
    },
    "unsplash": {
        "name": "unsplash",
        "display_name": "Unsplash",
        "base_url": "https://api.unsplash.com",
        "api_key_required": True,
        "rate_limit": 50,  # requests per hour
        "search_endpoint": "/search/photos",
        "video_search_endpoint": "/search/videos",
        "download_endpoint": "/download"
    },
    "videvo": {
        "name": "videvo",
        "display_name": "Videvo",
        "base_url": "https://www.videvo.net/api",
        "api_key_required": True,
        "rate_limit": 100,  # requests per hour
        "search_endpoint": "/search",
        "popular_endpoint": "/popular"
    },
    "coverr": {
        "name": "coverr",
        "display_name": "Coverr",
        "base_url": "https://api.coverr.co",
        "api_key_required": False,
        "rate_limit": 100,  # requests per hour
        "search_endpoint": "/search",
        "popular_endpoint": "/popular"
    }
}


def get_settings() -> Settings:
    """Get application settings."""
    return Settings()


def get_media_source_config(source_name: str) -> Optional[Dict]:
    """Get configuration for a specific media source."""
    return MEDIA_SOURCES.get(source_name)


def get_all_media_sources() -> Dict[str, Dict]:
    """Get all media source configurations."""
    return MEDIA_SOURCES


def get_api_key_for_source(settings: Settings, source_name: str) -> Optional[str]:
    """Get API key for a specific media source."""
    key_map = {
        "pexels": settings.pexels_api_key,
        "pixabay": settings.pixabay_api_key,
        "unsplash": settings.unsplash_api_key,
        "videvo": settings.videvo_api_key,
        "coverr": settings.coverr_api_key
    }
    return key_map.get(source_name)