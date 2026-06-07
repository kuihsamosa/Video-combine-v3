"""
SQLAlchemy models for download management.
"""

import uuid
import os
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column, String, DateTime, Integer, Float, Boolean, Text,
    ForeignKey, Index, UniqueConstraint
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

Base = declarative_base()


class Download(Base):
    """
    Model for tracking media downloads.
    """
    __tablename__ = "downloads"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    
    # Media information
    media_id = Column(String(255), nullable=False)  # ID from the source
    media_url = Column(Text, nullable=False)  # Original URL to download
    media_title = Column(String(500), nullable=True)  # Title of the media
    media_source = Column(String(50), nullable=False)  # pexels, pixabay, etc.
    media_type = Column(String(20), nullable=False)  # video, image
    
    # File information
    filename = Column(String(500), nullable=False)  # Original filename
    file_path = Column(String(1000), nullable=True)  # Local file path
    file_size = Column(Integer, nullable=True)  # File size in bytes
    mime_type = Column(String(100), nullable=True)  # MIME type of the file
    
    # Download status
    status = Column(String(20), nullable=False, default="pending")  # pending, downloading, paused, completed, failed, cancelled
    progress = Column(Float, default=0.0)  # Download progress (0.0 to 100.0)
    
    # Download details
    total_bytes = Column(Integer, nullable=True)  # Total size to download
    downloaded_bytes = Column(Integer, default=0)  # Bytes downloaded so far
    download_speed = Column(Float, nullable=True)  # Current download speed in bytes/sec
    eta_seconds = Column(Integer, nullable=True)  # Estimated time remaining in seconds
    
    # Retry information
    retry_count = Column(Integer, default=0)
    max_retries = Column(Integer, default=3)
    
    # Error information
    error_message = Column(Text, nullable=True)
    error_code = Column(String(50), nullable=True)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    
    # Relationships
    chunks = relationship("DownloadChunk", back_populates="download", cascade="all, delete-orphan")
    history = relationship("DownloadHistory", back_populates="download", cascade="all, delete-orphan")
    
    # Constraints
    __table_args__ = (
        Index('idx_media_source', 'media_source', 'media_id'),
        Index('idx_status', 'status'),
        Index('idx_created_at', 'created_at'),
        Index('idx_user_downloads', 'media_source', 'created_at'),
    )
    
    def __repr__(self):
        return f"<Download(id={self.id}, media_source={self.media_source}, status={self.status}, progress={self.progress}%)>"


class DownloadChunk(Base):
    """
    Model for tracking download chunks (for resume functionality).
    """
    __tablename__ = "download_chunks"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    download_id = Column(String(36), ForeignKey("downloads.id"), nullable=False)
    
    # Chunk information
    chunk_number = Column(Integer, nullable=False)  # Sequential chunk number
    start_byte = Column(Integer, nullable=False)  # Starting byte position
    end_byte = Column(Integer, nullable=False)  # Ending byte position
    downloaded_bytes = Column(Integer, default=0)  # Bytes downloaded for this chunk
    
    # Status
    status = Column(String(20), nullable=False, default="pending")  # pending, downloading, completed, failed
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
    
    # Relationships
    download = relationship("Download", back_populates="chunks")
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('download_id', 'chunk_number', name='uq_download_chunk'),
        Index('idx_download_status', 'download_id', 'status'),
    )
    
    def __repr__(self):
        return f"<DownloadChunk(id={self.id}, download_id={self.download_id}, chunk={self.chunk_number}, status={self.status})>"


class DownloadHistory(Base):
    """
    Model for tracking download history and statistics.
    """
    __tablename__ = "download_history"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    download_id = Column(String(36), ForeignKey("downloads.id"), nullable=False)
    
    # Action information
    action = Column(String(20), nullable=False)  # created, started, paused, resumed, completed, failed, cancelled, retried
    
    # Additional context
    message = Column(Text, nullable=True)  # Additional information about the action
    progress_at_time = Column(Float, nullable=True)  # Progress percentage at the time of this action
    speed_at_time = Column(Float, nullable=True)  # Download speed at the time of this action
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # Relationships
    download = relationship("Download", back_populates="history")
    
    # Constraints
    __table_args__ = (
        Index('idx_download_action', 'download_id', 'action'),
        Index('idx_download_history_created_at', 'created_at'),
    )
    
    def __repr__(self):
        return f"<DownloadHistory(id={self.id}, download_id={self.download_id}, action={self.action}, created_at={self.created_at})>"


class DownloadStatistics(Base):
    """
    Model for tracking download statistics.
    """
    __tablename__ = "download_statistics"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    
    # Period information
    period_type = Column(String(10), nullable=False)  # 'hour', 'day', 'week', 'month'
    period_start = Column(DateTime(timezone=True), nullable=False)
    period_end = Column(DateTime(timezone=True), nullable=False)
    
    # Download counts
    total_downloads = Column(Integer, default=0)
    completed_downloads = Column(Integer, default=0)
    failed_downloads = Column(Integer, default=0)
    cancelled_downloads = Column(Integer, default=0)
    
    # Data transferred
    total_bytes_downloaded = Column(Integer, default=0)
    
    # Performance metrics
    avg_download_speed = Column(Float, nullable=True)  # Average speed in bytes/sec
    avg_download_time = Column(Float, nullable=True)  # Average time in seconds
    
    # Source breakdown
    source_stats = Column(Text, nullable=True)  # JSON string with source-specific stats
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('period_type', 'period_start', name='uq_period_type_start'),
        Index('idx_period_type', 'period_type', 'period_start'),
    )
    
    def __repr__(self):
        return f"<DownloadStatistics(id={self.id}, period={self.period_type}, total={self.total_downloads}, completed={self.completed_downloads})>"