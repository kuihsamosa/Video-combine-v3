"""
API endpoints for download management.
"""

from typing import Dict, List, Optional, Any
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from services.download_service import download_service
from models.downloads import Download, DownloadHistory


# Pydantic models for request/response
class DownloadRequest(BaseModel):
    media_id: str = Field(..., description="ID of the media from the source")
    media_url: str = Field(..., description="URL to download the media from")
    media_title: str = Field(..., description="Title of the media")
    media_source: str = Field(..., description="Source of the media (pexels, pixabay, etc.)")
    media_type: str = Field(..., pattern="^(video|image)$", description="Type of media (video, image)")


class DownloadResponse(BaseModel):
    id: str
    media_id: str
    media_url: str
    media_title: str
    media_source: str
    media_type: str
    filename: str
    file_path: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    status: str
    progress: float
    total_bytes: Optional[int] = None
    downloaded_bytes: int
    download_speed: Optional[float] = None
    eta_seconds: Optional[int] = None
    retry_count: int
    max_retries: int
    error_message: Optional[str] = None
    error_code: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


class DownloadHistoryResponse(BaseModel):
    id: str
    download_id: str
    action: str
    message: Optional[str] = None
    progress_at_time: Optional[float] = None
    speed_at_time: Optional[float] = None
    created_at: str


class DownloadListResponse(BaseModel):
    downloads: List[DownloadResponse]
    total: int
    page: int
    per_page: int


class ActionResponse(BaseModel):
    success: bool
    message: str
    download: Optional[DownloadResponse] = None


# Create router
router = APIRouter(prefix="/api/downloads", tags=["downloads"])


# Helper function to convert Download to dict
def download_to_dict(download: Download) -> Dict[str, Any]:
    """Convert a Download model to a dictionary."""
    return {
        "id": download.id,
        "media_id": download.media_id,
        "media_url": download.media_url,
        "media_title": download.media_title,
        "media_source": download.media_source,
        "media_type": download.media_type,
        "filename": download.filename,
        "file_path": download.file_path,
        "file_size": download.file_size,
        "mime_type": download.mime_type,
        "status": download.status,
        "progress": download.progress,
        "total_bytes": download.total_bytes,
        "downloaded_bytes": download.downloaded_bytes,
        "download_speed": download.download_speed,
        "eta_seconds": download.eta_seconds,
        "retry_count": download.retry_count,
        "max_retries": download.max_retries,
        "error_message": download.error_message,
        "error_code": download.error_code,
        "created_at": download.created_at.isoformat() if download.created_at else None,
        "updated_at": download.updated_at.isoformat() if download.updated_at else None,
        "started_at": download.started_at.isoformat() if download.started_at else None,
        "completed_at": download.completed_at.isoformat() if download.completed_at else None,
    }


def download_history_to_dict(history: DownloadHistory) -> Dict[str, Any]:
    """Convert a DownloadHistory model to a dictionary."""
    return {
        "id": history.id,
        "download_id": history.download_id,
        "action": history.action,
        "message": history.message,
        "progress_at_time": history.progress_at_time,
        "speed_at_time": history.speed_at_time,
        "created_at": history.created_at.isoformat() if history.created_at else None,
    }


# GET /api/downloads - Get all downloads
@router.get("/", response_model=DownloadListResponse)
async def get_downloads(
    status: Optional[str] = Query(None, description="Filter by status"),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Number of results per page"),
    db: Session = Depends(get_db)
):
    """Get all downloads, optionally filtered by status."""
    try:
        downloads = download_service.get_downloads(db, status)
        
        # Apply pagination
        start = (page - 1) * per_page
        end = start + per_page
        paginated_downloads = downloads[start:end]
        
        return DownloadListResponse(
            downloads=[download_to_dict(d) for d in paginated_downloads],
            total=len(downloads),
            page=page,
            per_page=per_page
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get downloads: {str(e)}")


# POST /api/downloads - Start a new download
@router.post("/", response_model=ActionResponse)
async def start_download(
    request: DownloadRequest,
    db: Session = Depends(get_db)
):
    """Start a new download."""
    try:
        download = await download_service.start_download(
            media_id=request.media_id,
            media_url=request.media_url,
            media_title=request.media_title,
            media_source=request.media_source,
            media_type=request.media_type,
            db=db
        )
        
        return ActionResponse(
            success=True,
            message="Download started successfully",
            download=download_to_dict(download)
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start download: {str(e)}")


# GET /api/downloads/{download_id} - Get a specific download
@router.get("/{download_id}", response_model=DownloadResponse)
async def get_download(
    download_id: str,
    db: Session = Depends(get_db)
):
    """Get a specific download by ID."""
    try:
        download = download_service.get_download(download_id, db)
        
        if not download:
            raise HTTPException(status_code=404, detail="Download not found")
        
        return download_to_dict(download)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get download: {str(e)}")


# DELETE /api/downloads/{download_id} - Delete/cancel a download
@router.delete("/{download_id}", response_model=ActionResponse)
async def delete_download(
    download_id: str,
    db: Session = Depends(get_db)
):
    """Delete/cancel a download."""
    try:
        success = await download_service.cancel_download(download_id, db)
        
        if not success:
            raise HTTPException(status_code=404, detail="Download not found or cannot be cancelled")
        
        return ActionResponse(
            success=True,
            message="Download cancelled successfully"
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to cancel download: {str(e)}")


# POST /api/downloads/{download_id}/pause - Pause a download
@router.post("/{download_id}/pause", response_model=ActionResponse)
async def pause_download(
    download_id: str,
    db: Session = Depends(get_db)
):
    """Pause a download."""
    try:
        success = await download_service.pause_download(download_id, db)
        
        if not success:
            raise HTTPException(status_code=404, detail="Download not found or cannot be paused")
        
        # Get updated download
        download = download_service.get_download(download_id, db)
        
        return ActionResponse(
            success=True,
            message="Download paused successfully",
            download=download_to_dict(download) if download else None
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to pause download: {str(e)}")


# POST /api/downloads/{download_id}/resume - Resume a download
@router.post("/{download_id}/resume", response_model=ActionResponse)
async def resume_download(
    download_id: str,
    db: Session = Depends(get_db)
):
    """Resume a download."""
    try:
        success = await download_service.resume_download(download_id, db)
        
        if not success:
            raise HTTPException(status_code=404, detail="Download not found or cannot be resumed")
        
        # Get updated download
        download = download_service.get_download(download_id, db)
        
        return ActionResponse(
            success=True,
            message="Download resumed successfully",
            download=download_to_dict(download) if download else None
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to resume download: {str(e)}")


# POST /api/downloads/{download_id}/retry - Retry a failed download
@router.post("/{download_id}/retry", response_model=ActionResponse)
async def retry_download(
    download_id: str,
    db: Session = Depends(get_db)
):
    """Retry a failed download."""
    try:
        success = await download_service.retry_download(download_id, db)
        
        if not success:
            raise HTTPException(status_code=404, detail="Download not found or cannot be retried")
        
        # Get updated download
        download = download_service.get_download(download_id, db)
        
        return ActionResponse(
            success=True,
            message="Download retry initiated successfully",
            download=download_to_dict(download) if download else None
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retry download: {str(e)}")


# GET /api/downloads/{download_id}/history - Get download history
@router.get("/{download_id}/history", response_model=List[DownloadHistoryResponse])
async def get_download_history(
    download_id: str,
    db: Session = Depends(get_db)
):
    """Get the history for a specific download."""
    try:
        # Check if download exists
        download = download_service.get_download(download_id, db)
        if not download:
            raise HTTPException(status_code=404, detail="Download not found")
        
        history = download_service.get_download_history(download_id, db)
        
        return [download_history_to_dict(h) for h in history]
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get download history: {str(e)}")


# GET /api/downloads/stats - Get download statistics
@router.get("/stats", response_model=Dict[str, Any])
async def get_download_stats(
    db: Session = Depends(get_db)
):
    """Get download statistics."""
    try:
        # Get all downloads
        all_downloads = download_service.get_downloads(db)
        
        # Calculate statistics
        total_downloads = len(all_downloads)
        completed_downloads = len([d for d in all_downloads if d.status == "completed"])
        failed_downloads = len([d for d in all_downloads if d.status == "failed"])
        active_downloads = len([d for d in all_downloads if d.status in ["downloading", "pending"]])
        paused_downloads = len([d for d in all_downloads if d.status == "paused"])
        
        # Calculate total bytes downloaded
        total_bytes = sum(d.file_size or 0 for d in all_downloads if d.file_size)
        
        # Calculate success rate
        success_rate = (completed_downloads / total_downloads * 100) if total_downloads > 0 else 0
        
        return {
            "total_downloads": total_downloads,
            "completed_downloads": completed_downloads,
            "failed_downloads": failed_downloads,
            "active_downloads": active_downloads,
            "paused_downloads": paused_downloads,
            "total_bytes_downloaded": total_bytes,
            "success_rate": round(success_rate, 2)
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get download statistics: {str(e)}")