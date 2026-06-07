"""
API endpoints for API key management.
"""

from typing import Dict, List, Optional, Any
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from services.api_key_manager import api_key_manager
from models.api_keys import APIKey, APIKeyUsage, APIKeyHistory
from config import get_media_source_config, get_all_media_sources


# Pydantic models for request/response
class APIKeyCreate(BaseModel):
    name: str = Field(..., description="Name for the API key")
    service: str = Field(..., description="Service name (pexels, pixabay, etc.)")
    api_key: str = Field(..., description="The API key")
    hourly_quota: int = Field(0, description="Hourly request quota (0 for unlimited)")
    daily_quota: int = Field(0, description="Daily request quota (0 for unlimited)")


class APIKeyUpdate(BaseModel):
    name: Optional[str] = Field(None, description="New name for the API key")
    api_key: Optional[str] = Field(None, description="New API key")
    hourly_quota: Optional[int] = Field(None, description="New hourly request quota")
    daily_quota: Optional[int] = Field(None, description="New daily request quota")
    is_active: Optional[bool] = Field(None, description="Whether the key is active")
    reason: Optional[str] = Field(None, description="Reason for the update")


class APIKeyResponse(BaseModel):
    id: str
    name: str
    service: str
    is_active: bool
    hourly_quota: int
    daily_quota: int
    created_at: str
    updated_at: Optional[str] = None
    last_used_at: Optional[str] = None
    
    class Config:
        from_attributes = True


class APIKeyMaskedResponse(BaseModel):
    id: str
    name: str
    service: str
    is_active: bool
    hourly_quota: int
    daily_quota: int
    created_at: str
    updated_at: Optional[str] = None
    last_used_at: Optional[str] = None
    masked_key: str


class APIKeyUsageResponse(BaseModel):
    key_id: str
    name: str
    service: str
    is_active: bool
    hourly_quota: int
    daily_quota: int
    requests_this_hour: int
    requests_today: int
    total_requests: int
    hourly_usage_percentage: float
    daily_usage_percentage: float
    time_until_reset: Optional[int] = None
    last_used_at: Optional[str] = None


class APIKeyTestRequest(BaseModel):
    key_id: str = Field(..., description="ID of the API key to test")


class APIKeyTestResponse(BaseModel):
    success: bool
    message: str
    key_id: str
    name: str
    service: str


class APIKeyRotateRequest(BaseModel):
    key_id: str = Field(..., description="ID of the API key to rotate")
    new_key: str = Field(..., description="New API key")
    reason: Optional[str] = Field(None, description="Reason for rotation")


class APIKeyHistoryResponse(BaseModel):
    id: str
    action: str
    previous_name: Optional[str] = None
    new_name: Optional[str] = None
    reason: Optional[str] = None
    changed_by: Optional[str] = None
    created_at: str
    
    class Config:
        from_attributes = True


class UsageStatsResponse(BaseModel):
    key_id: str
    name: str
    service: str
    requests_this_hour: int
    requests_today: int
    total_requests: int
    hourly_quota: int
    daily_quota: int
    hourly_usage_percentage: float
    daily_usage_percentage: float
    time_until_reset: Optional[int] = None


class APIKeysListResponse(BaseModel):
    keys: List[APIKeyMaskedResponse]
    total: int


# Create router
router = APIRouter(prefix="/api/keys", tags=["api keys"])


# Helper functions
def mask_api_key(api_key: str) -> str:
    """Mask an API key for security."""
    if len(api_key) <= 12:
        return "****"
    return f"{api_key[:8]}...{api_key[-4:]}"


def api_key_to_response(db_key: APIKey, mask: bool = True) -> APIKeyResponse:
    """Convert a database API key to a response model."""
    response_data = {
        "id": str(db_key.id),
        "name": db_key.name,
        "service": db_key.service,
        "is_active": db_key.is_active,
        "hourly_quota": db_key.hourly_quota,
        "daily_quota": db_key.daily_quota,
        "created_at": db_key.created_at.isoformat(),
        "updated_at": db_key.updated_at.isoformat() if db_key.updated_at else None,
        "last_used_at": db_key.last_used_at.isoformat() if db_key.last_used_at else None,
    }
    
    if mask:
        # Decrypt and mask the key
        try:
            decrypted_key = api_key_manager.get_decrypted_key(db_key)
            response_data["masked_key"] = mask_api_key(decrypted_key)
        except:
            response_data["masked_key"] = "****"
        
        return APIKeyMaskedResponse(**response_data)
    else:
        return APIKeyResponse(**response_data)


# API endpoints
@router.get("/", response_model=APIKeysListResponse)
async def get_all_api_keys(
    service: Optional[str] = Query(None, description="Filter by service"),
    active_only: bool = Query(True, description="Only return active keys"),
    db: Session = Depends(get_db)
):
    """Get all API keys (masked for security)."""
    try:
        if service:
            if service not in get_all_media_sources():
                raise HTTPException(status_code=404, detail=f"Service '{service}' not found")
            db_keys = api_key_manager.get_api_keys_by_service_legacy(service, active_only)
        else:
            db_keys = api_key_manager.get_all_api_keys_legacy(active_only)
        
        response_keys = [api_key_to_response(db_key, mask=True) for db_key in db_keys]
        
        return APIKeysListResponse(
            keys=response_keys,
            total=len(response_keys)
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get API keys: {str(e)}")


@router.get("/{key_id}", response_model=APIKeyResponse)
async def get_api_key(
    key_id: str,
    db: Session = Depends(get_db)
):
    """Get a specific API key (unmasked)."""
    try:
        db_key = api_key_manager.get_api_key_by_id(db, key_id)
        if not db_key:
            raise HTTPException(status_code=404, detail="API key not found")
        
        return api_key_to_response(db_key, mask=False)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get API key: {str(e)}")


@router.post("/", response_model=APIKeyResponse)
async def create_api_key(
    key_data: APIKeyCreate,
    db: Session = Depends(get_db)
):
    """Create a new API key."""
    try:
        # Validate service
        all_sources = get_all_media_sources()
        if key_data.service not in all_sources:
            raise HTTPException(status_code=404, detail=f"Service '{key_data.service}' not found")
        
        db_key = api_key_manager.create_api_key(
            db=db,
            name=key_data.name,
            service=key_data.service,
            api_key=key_data.api_key,
            hourly_quota=key_data.hourly_quota,
            daily_quota=key_data.daily_quota
        )
        
        return api_key_to_response(db_key, mask=False)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create API key: {str(e)}")


@router.put("/{key_id}", response_model=APIKeyResponse)
async def update_api_key(
    key_id: str,
    key_data: APIKeyUpdate,
    db: Session = Depends(get_db)
):
    """Update an existing API key."""
    try:
        db_key = api_key_manager.update_api_key(
            db=db,
            key_id=key_id,
            name=key_data.name,
            api_key=key_data.api_key,
            hourly_quota=key_data.hourly_quota,
            daily_quota=key_data.daily_quota,
            is_active=key_data.is_active,
            reason=key_data.reason
        )
        
        if not db_key:
            raise HTTPException(status_code=404, detail="API key not found")
        
        return api_key_to_response(db_key, mask=False)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update API key: {str(e)}")


@router.delete("/{key_id}")
async def delete_api_key(
    key_id: str,
    reason: Optional[str] = Query(None, description="Reason for deletion"),
    db: Session = Depends(get_db)
):
    """Delete an API key."""
    try:
        success = api_key_manager.delete_api_key(db, key_id, reason)
        
        if not success:
            raise HTTPException(status_code=404, detail="API key not found")
        
        return {"message": "API key deleted successfully"}
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete API key: {str(e)}")


@router.post("/test", response_model=APIKeyTestResponse)
async def test_api_key(
    request: APIKeyTestRequest,
    db: Session = Depends(get_db)
):
    """Test if an API key is valid."""
    try:
        db_key = api_key_manager.get_api_key_by_id(db, request.key_id)
        if not db_key:
            raise HTTPException(status_code=404, detail="API key not found")
        
        success, message = api_key_manager.test_api_key(db, request.key_id)
        
        return APIKeyTestResponse(
            success=success,
            message=message,
            key_id=str(db_key.id),
            name=db_key.name,
            service=db_key.service
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to test API key: {str(e)}")


@router.post("/rotate", response_model=APIKeyResponse)
async def rotate_api_key(
    request: APIKeyRotateRequest,
    db: Session = Depends(get_db)
):
    """Rotate an API key with a new one."""
    try:
        success = api_key_manager.rotate_api_key(
            db=db,
            key_id=request.key_id,
            new_key=request.new_key,
            reason=request.reason
        )
        
        if not success:
            raise HTTPException(status_code=404, detail="API key not found")
        
        db_key = api_key_manager.get_api_key_by_id(db, request.key_id)
        return api_key_to_response(db_key, mask=False)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to rotate API key: {str(e)}")


@router.get("/{key_id}/usage", response_model=APIKeyUsageResponse)
async def get_api_key_usage(
    key_id: str,
    db: Session = Depends(get_db)
):
    """Get usage statistics for a specific API key."""
    try:
        db_key = api_key_manager.get_api_key_by_id(db, key_id)
        if not db_key:
            raise HTTPException(status_code=404, detail="API key not found")
        
        usage_stats = api_key_manager.get_usage_stats(db, key_id)
        
        return APIKeyUsageResponse(**usage_stats)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get usage stats: {str(e)}")


@router.get("/{key_id}/history", response_model=List[APIKeyHistoryResponse])
async def get_api_key_history(
    key_id: str,
    db: Session = Depends(get_db)
):
    """Get the history of changes for an API key."""
    try:
        db_key = api_key_manager.get_api_key_by_id(db, key_id)
        if not db_key:
            raise HTTPException(status_code=404, detail="API key not found")
        
        history = api_key_manager.get_key_history(db, key_id)
        
        return [
            APIKeyHistoryResponse(
                id=str(h.id),
                action=h.action,
                previous_name=h.previous_name,
                new_name=h.new_name,
                reason=h.reason,
                changed_by=h.changed_by,
                created_at=h.created_at.isoformat()
            )
            for h in history
        ]
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get API key history: {str(e)}")


@router.get("/services/{service}/active", response_model=APIKeyResponse)
async def get_active_key_for_service(
    service: str,
    db: Session = Depends(get_db)
):
    """Get the active API key for a specific service."""
    try:
        if service not in get_all_media_sources():
            raise HTTPException(status_code=404, detail=f"Service '{service}' not found")
        
        db_key = api_key_manager.get_api_key_legacy(service)
        if not db_key:
            raise HTTPException(status_code=404, detail=f"No active API key found for service '{service}'")
        
        return api_key_to_response(db_key, mask=False)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get active API key: {str(e)}")


@router.get("/usage/summary", response_model=List[UsageStatsResponse])
async def get_usage_summary(
    service: Optional[str] = Query(None, description="Filter by service"),
    db: Session = Depends(get_db)
):
    """Get usage statistics for all API keys."""
    try:
        if service:
            if service not in get_all_media_sources():
                raise HTTPException(status_code=404, detail=f"Service '{service}' not found")
            db_keys = api_key_manager.get_api_keys_by_service(db, service, active_only=True)
        else:
            db_keys = api_key_manager.get_all_api_keys(db, active_only=True)
        
        usage_stats = []
        for db_key in db_keys:
            stats = api_key_manager.get_usage_stats(db, str(db_key.id))
            usage_stats.append(UsageStatsResponse(**stats))
        
        return usage_stats
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get usage summary: {str(e)}")