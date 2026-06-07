"""
Service for handling media downloads with progress tracking, pause/resume, and retry logic.
"""

import os
import asyncio
import aiohttp
import aiofiles
import uuid
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Callable
from urllib.parse import urlparse, unquote
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_

from database import get_db
from models.downloads import Download, DownloadChunk, DownloadHistory, DownloadStatistics
from config import get_settings


class DownloadService:
    """
    Service for managing media downloads with progress tracking and resume capability.
    """
    
    def __init__(self):
        self.settings = get_settings()
        self.active_downloads: Dict[str, asyncio.Task] = {}
        self.download_dir = os.path.join(os.getcwd(), "downloads")
        
        # Ensure download directory exists
        os.makedirs(self.download_dir, exist_ok=True)
    
    async def start_download(
        self,
        media_id: str,
        media_url: str,
        media_title: str,
        media_source: str,
        media_type: str,
        db: Session
    ) -> Download:
        """
        Start a new download.
        
        Args:
            media_id: ID of the media from the source
            media_url: URL to download the media from
            media_title: Title of the media
            media_source: Source of the media (pexels, pixabay, etc.)
            media_type: Type of media (video, image)
            db: Database session
            
        Returns:
            Download object
        """
        # Check if download already exists
        existing_download = db.query(Download).filter(
            and_(
                Download.media_id == media_id,
                Download.media_source == media_source,
                or_(
                    Download.status == "pending",
                    Download.status == "downloading",
                    Download.status == "paused"
                )
            )
        ).first()
        
        if existing_download:
            return existing_download
        
        # Generate filename from URL or title
        filename = self._generate_filename(media_url, media_title, media_type)
        
        # Create new download record
        download = Download(
            media_id=media_id,
            media_url=media_url,
            media_title=media_title,
            media_source=media_source,
            media_type=media_type,
            filename=filename,
            file_path=os.path.join(self.download_dir, filename),
            status="pending"
        )
        
        db.add(download)
        db.commit()
        db.refresh(download)
        
        # Add history record
        self._add_history_record(download.id, "created", "Download created", db)
        
        # Start the download task
        if download.id not in self.active_downloads:
            task = asyncio.create_task(self._download_file(download.id, db))
            self.active_downloads[download.id] = task
        
        return download
    
    async def pause_download(self, download_id: str, db: Session) -> bool:
        """
        Pause a download.
        
        Args:
            download_id: ID of the download to pause
            db: Database session
            
        Returns:
            True if successful, False otherwise
        """
        download = db.query(Download).filter(Download.id == download_id).first()
        if not download:
            return False
        
        if download.status in ["downloading", "pending"]:
            download.status = "paused"
            db.commit()
            
            # Add history record
            self._add_history_record(
                download_id, 
                "paused", 
                f"Download paused at {download.progress:.1f}%", 
                db,
                progress_at_time=download.progress
            )
            
            # Cancel the active task if it exists
            if download_id in self.active_downloads:
                self.active_downloads[download_id].cancel()
                del self.active_downloads[download_id]
            
            return True
        
        return False
    
    async def resume_download(self, download_id: str, db: Session) -> bool:
        """
        Resume a paused download.
        
        Args:
            download_id: ID of the download to resume
            db: Database session
            
        Returns:
            True if successful, False otherwise
        """
        download = db.query(Download).filter(Download.id == download_id).first()
        if not download:
            return False
        
        if download.status == "paused":
            download.status = "pending"
            db.commit()
            
            # Add history record
            self._add_history_record(
                download_id, 
                "resumed", 
                f"Download resumed from {download.progress:.1f}%", 
                db,
                progress_at_time=download.progress
            )
            
            # Start the download task
            if download_id not in self.active_downloads:
                task = asyncio.create_task(self._download_file(download_id, db))
                self.active_downloads[download_id] = task
            
            return True
        
        return False
    
    async def cancel_download(self, download_id: str, db: Session) -> bool:
        """
        Cancel a download.
        
        Args:
            download_id: ID of the download to cancel
            db: Database session
            
        Returns:
            True if successful, False otherwise
        """
        download = db.query(Download).filter(Download.id == download_id).first()
        if not download:
            return False
        
        if download.status in ["pending", "downloading", "paused"]:
            download.status = "cancelled"
            db.commit()
            
            # Add history record
            self._add_history_record(
                download_id, 
                "cancelled", 
                f"Download cancelled at {download.progress:.1f}%", 
                db,
                progress_at_time=download.progress
            )
            
            # Cancel the active task if it exists
            if download_id in self.active_downloads:
                self.active_downloads[download_id].cancel()
                del self.active_downloads[download_id]
            
            # Delete partial file
            if download.file_path and os.path.exists(download.file_path):
                try:
                    os.remove(download.file_path)
                except OSError:
                    pass
            
            return True
        
        return False
    
    async def retry_download(self, download_id: str, db: Session) -> bool:
        """
        Retry a failed download.
        
        Args:
            download_id: ID of the download to retry
            db: Database session
            
        Returns:
            True if successful, False otherwise
        """
        download = db.query(Download).filter(Download.id == download_id).first()
        if not download:
            return False
        
        if download.status == "failed" and download.retry_count < download.max_retries:
            download.status = "pending"
            download.retry_count += 1
            download.error_message = None
            download.error_code = None
            db.commit()
            
            # Add history record
            self._add_history_record(
                download_id, 
                "retried", 
                f"Download retry #{download.retry_count}", 
                db
            )
            
            # Start the download task
            if download_id not in self.active_downloads:
                task = asyncio.create_task(self._download_file(download_id, db))
                self.active_downloads[download_id] = task
            
            return True
        
        return False
    
    def get_downloads(self, db: Session, status: Optional[str] = None) -> List[Download]:
        """
        Get all downloads, optionally filtered by status.
        
        Args:
            db: Database session
            status: Optional status filter
            
        Returns:
            List of Download objects
        """
        query = db.query(Download)
        if status:
            query = query.filter(Download.status == status)
        
        return query.order_by(Download.created_at.desc()).all()
    
    def get_download(self, download_id: str, db: Session) -> Optional[Download]:
        """
        Get a specific download by ID.
        
        Args:
            download_id: ID of the download
            db: Database session
            
        Returns:
            Download object or None
        """
        return db.query(Download).filter(Download.id == download_id).first()
    
    def get_download_history(self, download_id: str, db: Session) -> List[DownloadHistory]:
        """
        Get the history for a specific download.
        
        Args:
            download_id: ID of the download
            db: Database session
            
        Returns:
            List of DownloadHistory objects
        """
        return db.query(DownloadHistory).filter(
            DownloadHistory.download_id == download_id
        ).order_by(DownloadHistory.created_at.asc()).all()
    
    async def _download_file(self, download_id: str, db: Session):
        """
        Internal method to handle the actual file download.
        
        Args:
            download_id: ID of the download
            db: Database session
        """
        try:
            # Get download record
            download = db.query(Download).filter(Download.id == download_id).first()
            if not download:
                return
            
            # Update status to downloading
            download.status = "downloading"
            download.started_at = datetime.utcnow()
            db.commit()
            
            # Add history record
            self._add_history_record(download_id, "started", "Download started", db)
            
            # Get file info
            async with aiohttp.ClientSession() as session:
                # Get file size
                async with session.head(download.media_url) as response:
                    if response.status != 200:
                        raise Exception(f"Failed to access file: HTTP {response.status}")
                    
                    download.total_bytes = int(response.headers.get('content-length', 0))
                    download.mime_type = response.headers.get('content-type', '')
                    db.commit()
                
                # Check if file exists and get current size for resume
                current_size = 0
                if os.path.exists(download.file_path):
                    current_size = os.path.getsize(download.file_path)
                
                # Set up headers for resume
                headers = {}
                if current_size > 0:
                    headers['Range'] = f'bytes={current_size}-'
                    download.downloaded_bytes = current_size
                    download.progress = (current_size / download.total_bytes * 100) if download.total_bytes > 0 else 0
                    db.commit()
                
                # Start download
                async with session.get(download.media_url, headers=headers) as response:
                    if response.status not in [200, 206]:  # 206 is partial content
                        raise Exception(f"Download failed: HTTP {response.status}")
                    
                    # Open file for writing (append if resuming)
                    mode = 'ab' if current_size > 0 else 'wb'
                    async with aiofiles.open(download.file_path, mode) as file:
                        downloaded = current_size
                        last_update = datetime.utcnow()
                        start_time = datetime.utcnow()
                        
                        async for chunk in response.content.iter_chunked(8192):
                            # Check if download was paused or cancelled
                            db.refresh(download)
                            if download.status in ["paused", "cancelled"]:
                                return
                            
                            await file.write(chunk)
                            downloaded += len(chunk)
                            
                            # Update progress every second or every 1MB
                            now = datetime.utcnow()
                            if (now - last_update).total_seconds() >= 1 or downloaded % (1024*1024) < 8192:
                                download.downloaded_bytes = downloaded
                                download.progress = (downloaded / download.total_bytes * 100) if download.total_bytes > 0 else 0
                                
                                # Calculate download speed
                                elapsed_seconds = (now - start_time).total_seconds()
                                if elapsed_seconds > 0:
                                    download.download_speed = downloaded / elapsed_seconds
                                    
                                    # Calculate ETA
                                    if download.total_bytes > 0 and download.download_speed > 0:
                                        remaining_bytes = download.total_bytes - downloaded
                                        download.eta_seconds = int(remaining_bytes / download.download_speed)
                                
                                db.commit()
                                last_update = now
            
            # Mark as completed
            download.status = "completed"
            download.progress = 100.0
            download.completed_at = datetime.utcnow()
            
            # Get final file size
            if os.path.exists(download.file_path):
                download.file_size = os.path.getsize(download.file_path)
            
            db.commit()
            
            # Add history record
            self._add_history_record(download_id, "completed", "Download completed successfully", db)
            
            # Update statistics
            self._update_statistics(download, db)
            
        except asyncio.CancelledError:
            # Download was cancelled
            pass
        except Exception as e:
            # Handle download error
            download = db.query(Download).filter(Download.id == download_id).first()
            if download:
                download.status = "failed"
                download.error_message = str(e)
                db.commit()
                
                # Add history record
                self._add_history_record(
                    download_id, 
                    "failed", 
                    f"Download failed: {str(e)}", 
                    db
                )
        finally:
            # Remove from active downloads
            if download_id in self.active_downloads:
                del self.active_downloads[download_id]
    
    def _generate_filename(self, url: str, title: str, media_type: str) -> str:
        """
        Generate a filename from URL or title.
        
        Args:
            url: URL of the media
            title: Title of the media
            media_type: Type of media (video, image)
            
        Returns:
            Generated filename
        """
        # Try to extract filename from URL
        parsed_url = urlparse(url)
        path = unquote(parsed_url.path)
        filename = os.path.basename(path)
        
        # If no filename or it's just a slash, use title
        if not filename or filename == '/':
            # Sanitize title
            safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).rstrip()
            filename = f"{safe_title}.{media_type}"
        
        # Add UUID to ensure uniqueness
        name, ext = os.path.splitext(filename)
        return f"{name}_{uuid.uuid4().hex[:8]}{ext}"
    
    def _add_history_record(
        self, 
        download_id: str, 
        action: str, 
        message: str, 
        db: Session,
        progress_at_time: Optional[float] = None,
        speed_at_time: Optional[float] = None
    ):
        """
        Add a history record for a download.
        
        Args:
            download_id: ID of the download
            action: Action performed
            message: Message describing the action
            db: Database session
            progress_at_time: Progress at the time of action
            speed_at_time: Download speed at the time of action
        """
        history = DownloadHistory(
            download_id=download_id,
            action=action,
            message=message,
            progress_at_time=progress_at_time,
            speed_at_time=speed_at_time
        )
        
        db.add(history)
        db.commit()
    
    def _update_statistics(self, download: Download, db: Session):
        """
        Update download statistics.
        
        Args:
            download: Completed download
            db: Database session
        """
        # Get current date
        now = datetime.utcnow()
        
        # Update daily statistics
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        stats = db.query(DownloadStatistics).filter(
            and_(
                DownloadStatistics.period_type == "day",
                DownloadStatistics.period_start == day_start
            )
        ).first()
        
        if not stats:
            stats = DownloadStatistics(
                period_type="day",
                period_start=day_start,
                period_end=day_start.replace(hour=23, minute=59, second=59, microsecond=999999)
            )
            db.add(stats)
        
        stats.total_downloads += 1
        stats.completed_downloads += 1
        stats.total_bytes_downloaded += download.file_size or 0
        
        db.commit()


# Global download service instance
download_service = DownloadService()