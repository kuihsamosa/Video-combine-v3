"""
SQLAlchemy models for API key management.
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column, String, DateTime, Integer, Float, Boolean, Text,
    ForeignKey, Index, UniqueConstraint
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class APIKey(Base):
    """
    Model for storing encrypted API keys for different services.
    """
    __tablename__ = "api_keys"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(100), nullable=False)
    service = Column(String(50), nullable=False)  # pexels, pixabay, etc.
    encrypted_key = Column(Text, nullable=False)  # Encrypted API key
    is_active = Column(Boolean, default=True)
    
    # Quota management
    hourly_quota = Column(Integer, default=0)  # 0 means unlimited
    daily_quota = Column(Integer, default=0)   # 0 means unlimited
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    
    # Relationships
    usage_records = relationship("APIKeyUsage", back_populates="api_key", cascade="all, delete-orphan")
    history_records = relationship("APIKeyHistory", back_populates="api_key", cascade="all, delete-orphan")
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('service', 'name', name='uq_service_name'),
        Index('idx_service_active', 'service', 'is_active'),
    )
    
    def __repr__(self):
        return f"<APIKey(id={self.id}, service={self.service}, name={self.name})>"


class APIKeyUsage(Base):
    """
    Model for tracking API key usage statistics.
    """
    __tablename__ = "api_key_usage"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    api_key_id = Column(String(36), ForeignKey("api_keys.id"), nullable=False)
    
    # Usage counters
    requests_count = Column(Integer, default=0)
    
    # Time period for this record
    period_type = Column(String(10), nullable=False)  # 'hour', 'day', 'month'
    period_start = Column(DateTime(timezone=True), nullable=False)
    
    # Additional metrics
    success_count = Column(Integer, default=0)
    error_count = Column(Integer, default=0)
    avg_response_time = Column(Float, nullable=True)  # in milliseconds
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    api_key = relationship("APIKey", back_populates="usage_records")
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('api_key_id', 'period_type', 'period_start', name='uq_api_key_period'),
        Index('idx_api_key_period', 'api_key_id', 'period_type', 'period_start'),
    )
    
    def __repr__(self):
        return f"<APIKeyUsage(api_key_id={self.api_key_id}, period={self.period_type}, requests={self.requests_count})>"


class APIKeyHistory(Base):
    """
    Model for tracking API key changes and rotations.
    """
    __tablename__ = "api_key_history"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    api_key_id = Column(String(36), ForeignKey("api_keys.id"), nullable=False)
    
    # Action type
    action = Column(String(20), nullable=False)  # 'created', 'updated', 'rotated', 'deactivated', 'deleted'
    
    # Previous values (for audit trail)
    previous_encrypted_key = Column(Text, nullable=True)
    previous_name = Column(String(100), nullable=True)
    
    # New values
    new_encrypted_key = Column(Text, nullable=True)
    new_name = Column(String(100), nullable=True)
    
    # Additional context
    reason = Column(Text, nullable=True)  # Why the change was made
    changed_by = Column(String(100), nullable=True)  # Who made the change
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # Relationships
    api_key = relationship("APIKey", back_populates="history_records")
    
    # Constraints
    __table_args__ = (
        Index('idx_api_key_action', 'api_key_id', 'action'),
        Index('idx_created_at', 'created_at'),
    )
    
    def __repr__(self):
        return f"<APIKeyHistory(api_key_id={self.api_key_id}, action={self.action}, created_at={self.created_at})>"