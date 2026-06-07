from typing import Dict, List, Optional, Any
from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel, Field
from services.stock_media_service import StockMediaService, MediaItem
from services.api_key_manager import api_key_manager
from config import get_settings, get_media_source_config, get_all_media_sources


# Pydantic models for request/response
class SearchParams(BaseModel):
    query: str = Field(..., description="Search query")
    sources: Optional[List[str]] = Field(None, description="List of sources to search")
    per_page: int = Field(20, ge=1, le=100, description="Number of results per page")
    page: int = Field(1, ge=1, description="Page number")
    media_type: str = Field("video", pattern="^(video|image|all)$", description="Media type to search for")
    orientation: str = Field("all", pattern="^(landscape|portrait|all)$", description="Orientation preference")


class SearchResult(BaseModel):
    source: str
    query: str
    results: List[Dict[str, Any]]
    total_count: Optional[int] = None
    page: int
    per_page: int


class CombinedSearchResult(BaseModel):
    query: str
    results: Dict[str, List[Dict[str, Any]]]
    total_results: int
    page: int
    per_page: int
    sources_searched: List[str]


class APIKeyRequest(BaseModel):
    source: str = Field(..., description="Source name")
    api_key: str = Field(..., description="API key")


class APIKeyResponse(BaseModel):
    success: bool
    message: str


class APIKeyTestResponse(BaseModel):
    success: bool
    message: str
    source: str


class UsageStatsResponse(BaseModel):
    source: str
    requests_today: int
    requests_this_hour: int
    total_requests: int
    hourly_limit: int
    daily_limit: int
    usage_percentage: float
    time_until_reset: Optional[int] = None


class APIKeysResponse(BaseModel):
    keys: Dict[str, Optional[str]]
    usage_stats: Dict[str, UsageStatsResponse]


# Create router
router = APIRouter(prefix="/api", tags=["stock media"])


# Helper function to convert MediaItem to dict
def media_item_to_dict(item: MediaItem) -> Dict[str, Any]:
    return item.to_dict()


# Search endpoints
@router.get("/search", response_model=CombinedSearchResult)
async def search_all_sources(
    query: str = Query(..., description="Search query"),
    sources: Optional[str] = Query(None, description="Comma-separated list of sources"),
    per_page: int = Query(20, ge=1, le=100, description="Number of results per page"),
    page: int = Query(1, ge=1, description="Page number"),
    media_type: str = Query("video", regex="^(video|image|all)$", description="Media type to search for"),
    orientation: str = Query("all", regex="^(landscape|portrait|all)$", description="Orientation preference")
):
    """Search across all configured stock media sources."""
    try:
        # Parse sources if provided
        source_list = None
        if sources:
            source_list = [s.strip() for s in sources.split(",") if s.strip()]
        
        async with StockMediaService() as service:
            results = await service.search_all_sources(
                query=query,
                sources=source_list,
                per_page=per_page,
                page=page,
                media_type=media_type
            )
        
        # Convert MediaItem objects to dictionaries
        dict_results = {}
        total_results = 0
        sources_searched = []
        
        for source, items in results.items():
            dict_results[source] = [media_item_to_dict(item) for item in items]
            total_results += len(items)
            if items:  # Only include sources that returned results
                sources_searched.append(source)
        
        return CombinedSearchResult(
            query=query,
            results=dict_results,
            total_results=total_results,
            page=page,
            per_page=per_page,
            sources_searched=sources_searched
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@router.get("/sources/{source}/search", response_model=SearchResult)
async def search_specific_source(
    source: str,
    query: str = Query(..., description="Search query"),
    per_page: int = Query(20, ge=1, le=100, description="Number of results per page"),
    page: int = Query(1, ge=1, description="Page number"),
    media_type: str = Query("video", regex="^(video|image|all)$", description="Media type to search for"),
    orientation: str = Query("all", regex="^(landscape|portrait|all)$", description="Orientation preference")
):
    """Search a specific stock media source."""
    # Validate source
    if source not in get_all_media_sources():
        raise HTTPException(status_code=404, detail=f"Source '{source}' not found")
    
    try:
        async with StockMediaService() as service:
            if source == "pexels":
                results = await service.search_pexels(query, per_page, page)
            elif source == "pixabay":
                results = await service.search_pixabay(query, per_page, page, media_type)
            elif source == "unsplash":
                results = await service.search_unsplash(query, per_page, page, media_type)
            elif source == "videvo":
                results = await service.search_videvo(query, per_page, page)
            elif source == "coverr":
                results = await service.search_coverr(query, per_page, page)
            else:
                raise HTTPException(status_code=404, detail=f"Source '{source}' not supported")
        
        return SearchResult(
            source=source,
            query=query,
            results=[media_item_to_dict(item) for item in results],
            total_count=len(results),
            page=page,
            per_page=per_page
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed for {source}: {str(e)}")


@router.get("/sources/{source}/popular", response_model=SearchResult)
async def get_popular_media(
    source: str,
    per_page: int = Query(20, ge=1, le=100, description="Number of results per page"),
    page: int = Query(1, ge=1, description="Page number")
):
    """Get popular media from a specific source."""
    # Validate source
    if source not in get_all_media_sources():
        raise HTTPException(status_code=404, detail=f"Source '{source}' not found")
    
    try:
        async with StockMediaService() as service:
            results = await service.get_popular_media(source, per_page, page)
        
        return SearchResult(
            source=source,
            query="popular",
            results=[media_item_to_dict(item) for item in results],
            total_count=len(results),
            page=page,
            per_page=per_page
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get popular media from {source}: {str(e)}")


# API Key management endpoints
@router.get("/keys", response_model=APIKeysResponse)
async def get_api_keys():
    """Get all configured API keys (masked for security) and usage stats."""
    try:
        keys = api_key_manager.get_all_api_keys()
        usage_stats = {}
        
        for source in keys.keys():
            if source in get_all_media_sources():
                stats = api_key_manager.get_usage_stats(source)
                time_until_reset = api_key_manager.get_time_until_reset(source)
                
                usage_stats[source] = UsageStatsResponse(
                    source=source,
                    requests_today=stats["requests_today"],
                    requests_this_hour=stats["requests_this_hour"],
                    total_requests=stats["total_requests"],
                    hourly_limit=stats["hourly_limit"],
                    daily_limit=stats["daily_limit"],
                    usage_percentage=stats["usage_percentage"],
                    time_until_reset=time_until_reset
                )
        
        return APIKeysResponse(
            keys=keys,
            usage_stats=usage_stats
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get API keys: {str(e)}")


@router.post("/keys", response_model=APIKeyResponse)
async def add_api_key(request: APIKeyRequest):
    """Add or update an API key for a specific source."""
    try:
        # Validate source
        if request.source not in get_all_media_sources():
            raise HTTPException(status_code=404, detail=f"Source '{request.source}' not found")
        
        success = api_key_manager.add_api_key(request.source, request.api_key)
        
        if success:
            return APIKeyResponse(
                success=True,
                message=f"API key for {request.source} updated successfully"
            )
        else:
            return APIKeyResponse(
                success=False,
                message=f"Failed to update API key for {request.source}"
            )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to add API key: {str(e)}")


@router.delete("/keys/{source}", response_model=APIKeyResponse)
async def remove_api_key(source: str):
    """Remove an API key for a specific source."""
    try:
        # Validate source
        if source not in get_all_media_sources():
            raise HTTPException(status_code=404, detail=f"Source '{source}' not found")
        
        success = api_key_manager.remove_api_key(source)
        
        if success:
            return APIKeyResponse(
                success=True,
                message=f"API key for {source} removed successfully"
            )
        else:
            return APIKeyResponse(
                success=False,
                message=f"No API key found for {source}"
            )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to remove API key: {str(e)}")


@router.post("/keys/test", response_model=APIKeyTestResponse)
async def test_api_key(request: APIKeyRequest):
    """Test if an API key is valid for a specific source."""
    try:
        # Validate source
        if request.source not in get_all_media_sources():
            raise HTTPException(status_code=404, detail=f"Source '{request.source}' not found")
        
        # Temporarily set the API key for testing
        existing_key = api_key_manager.get_api_key(request.source)
        api_key_manager.add_api_key(request.source, request.api_key)
        
        # Test the key
        success, message = api_key_manager.test_api_key(request.source)
        
        # Restore the original key if it existed
        if existing_key:
            api_key_manager.add_api_key(request.source, existing_key)
        
        return APIKeyTestResponse(
            success=success,
            message=message,
            source=request.source
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to test API key: {str(e)}")


@router.get("/keys/{source}/test", response_model=APIKeyTestResponse)
async def test_existing_api_key(source: str):
    """Test the existing API key for a specific source."""
    try:
        # Validate source
        if source not in get_all_media_sources():
            raise HTTPException(status_code=404, detail=f"Source '{source}' not found")
        
        success, message = api_key_manager.test_api_key(source)
        
        return APIKeyTestResponse(
            success=success,
            message=message,
            source=source
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to test API key: {str(e)}")


@router.get("/keys/{source}/usage", response_model=UsageStatsResponse)
async def get_usage_stats(source: str):
    """Get usage statistics for a specific source."""
    try:
        # Validate source
        if source not in get_all_media_sources():
            raise HTTPException(status_code=404, detail=f"Source '{source}' not found")
        
        stats = api_key_manager.get_usage_stats(source)
        time_until_reset = api_key_manager.get_time_until_reset(source)
        
        return UsageStatsResponse(
            source=source,
            requests_today=stats["requests_today"],
            requests_this_hour=stats["requests_this_hour"],
            total_requests=stats["total_requests"],
            hourly_limit=stats["hourly_limit"],
            daily_limit=stats["daily_limit"],
            usage_percentage=stats["usage_percentage"],
            time_until_reset=time_until_reset
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get usage stats: {str(e)}")


# Configuration endpoints
@router.get("/sources")
async def get_all_sources():
    """Get all available media sources and their configurations."""
    try:
        sources = get_all_media_sources()
        
        # Add current API key status
        for source_name, config in sources.items():
            has_key = bool(api_key_manager.get_api_key(source_name))
            config["has_api_key"] = has_key
            # Skip rate limiting check for now as it requires key_id
            config["is_rate_limited"] = False
        
        return {"sources": sources}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get sources: {str(e)}")


@router.get("/config")
async def get_config():
    """Get current application configuration."""
    try:
        settings = get_settings()
        
        return {
            "default_per_page": settings.default_per_page,
            "max_per_page": settings.max_per_page,
            "default_sources": settings.default_sources,
            "max_retries": settings.max_retries,
            "retry_delay": settings.retry_delay
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get config: {str(e)}")