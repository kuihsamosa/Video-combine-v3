import os
import json
import time
import uuid
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta
from cryptography.fernet import Fernet
from sqlalchemy.orm import Session
from sqlalchemy import and_, func

from config import get_settings, get_media_source_config, get_all_media_sources
from database import get_db
from models.api_keys import APIKey, APIKeyUsage, APIKeyHistory


class APIKeyManager:
    """Manages API keys for different stock media services with encryption and quota tracking."""
    
    def __init__(self):
        self.settings = get_settings()
        self._encryption_key = self._get_or_create_encryption_key()
        self._cipher_suite = Fernet(self._encryption_key)
        
        # Legacy file-based storage (for backward compatibility)
        self._key_storage_file = "api_keys.enc"
        self._usage_file = "api_usage.json"
        self._api_keys = {}
        self._usage_data = {}
        
        # Try to load from file first (for migration)
        self._load_api_keys()
        self._load_usage_data()
    
    def _get_or_create_encryption_key(self) -> bytes:
        """Get or create an encryption key for storing API keys."""
        key_file = "encryption.key"
        if os.path.exists(key_file):
            with open(key_file, "rb") as f:
                return f.read()
        else:
            key = Fernet.generate_key()
            with open(key_file, "wb") as f:
                f.write(key)
            return key
    
    def _encrypt(self, data: str) -> bytes:
        """Encrypt sensitive data."""
        return self._cipher_suite.encrypt(data.encode())
    
    def _decrypt(self, encrypted_data: bytes) -> str:
        """Decrypt sensitive data."""
        return self._cipher_suite.decrypt(encrypted_data).decode()
    
    def _load_api_keys(self):
        """Load encrypted API keys from storage."""
        if os.path.exists(self._key_storage_file):
            try:
                with open(self._key_storage_file, "rb") as f:
                    encrypted_data = f.read()
                    decrypted_data = self._decrypt(encrypted_data)
                    self._api_keys = json.loads(decrypted_data)
            except Exception as e:
                print(f"Error loading API keys: {e}")
                self._api_keys = {}
        else:
            # Load from environment variables as fallback
            self._api_keys = {
                "pexels": self.settings.pexels_api_key,
                "pixabay": self.settings.pixabay_api_key,
                "unsplash": self.settings.unsplash_api_key,
                "videvo": self.settings.videvo_api_key,
                "coverr": self.settings.coverr_api_key
            }
    
    def _save_api_keys(self):
        """Save encrypted API keys to storage."""
        try:
            json_data = json.dumps(self._api_keys)
            encrypted_data = self._encrypt(json_data)
            with open(self._key_storage_file, "wb") as f:
                f.write(encrypted_data)
        except Exception as e:
            print(f"Error saving API keys: {e}")
    
    def _load_usage_data(self):
        """Load API usage data from storage."""
        if os.path.exists(self._usage_file):
            try:
                with open(self._usage_file, "r") as f:
                    self._usage_data = json.load(f)
            except Exception as e:
                print(f"Error loading usage data: {e}")
                self._usage_data = {}
    
    def _save_usage_data(self):
        """Save API usage data to storage."""
        try:
            with open(self._usage_file, "w") as f:
                json.dump(self._usage_data, f, indent=2)
        except Exception as e:
            print(f"Error saving usage data: {e}")
    
    # Database-based CRUD operations
    
    def create_api_key(self, db: Session, name: str, service: str, api_key: str,
                      hourly_quota: int = 0, daily_quota: int = 0) -> APIKey:
        """Create a new API key in the database."""
        # Validate service
        all_sources = get_all_media_sources()
        if service not in all_sources:
            raise ValueError(f"Service '{service}' is not supported")
        
        # Check if a key with the same name and service already exists
        existing_key = db.query(APIKey).filter(
            and_(APIKey.service == service, APIKey.name == name)
        ).first()
        
        if existing_key:
            raise ValueError(f"API key with name '{name}' already exists for service '{service}'")
        
        # Create new API key
        encrypted_key = self._encrypt(api_key).decode('utf-8')
        db_key = APIKey(
            name=name,
            service=service,
            encrypted_key=encrypted_key,
            hourly_quota=hourly_quota,
            daily_quota=daily_quota
        )
        
        db.add(db_key)
        db.commit()
        db.refresh(db_key)
        
        # Create history record
        history = APIKeyHistory(
            api_key_id=db_key.id,
            action="created",
            new_encrypted_key=encrypted_key,
            new_name=name,
            reason="Initial creation"
        )
        db.add(history)
        db.commit()
        
        return db_key
    
    def get_api_key_by_id(self, db: Session, key_id: str) -> Optional[APIKey]:
        """Get an API key by ID."""
        return db.query(APIKey).filter(APIKey.id == key_id).first()
    
    def get_api_keys_by_service(self, db: Session, service: str, active_only: bool = True) -> List[APIKey]:
        """Get all API keys for a specific service."""
        query = db.query(APIKey).filter(APIKey.service == service)
        if active_only:
            query = query.filter(APIKey.is_active == True)
        return query.all()
    
    def get_all_api_keys(self, db: Session, active_only: bool = True) -> List[APIKey]:
        """Get all API keys."""
        query = db.query(APIKey)
        if active_only:
            query = query.filter(APIKey.is_active == True)
        return query.all()
    
    def update_api_key(self, db: Session, key_id: str, name: Optional[str] = None, 
                      api_key: Optional[str] = None, hourly_quota: Optional[int] = None,
                      daily_quota: Optional[int] = None, is_active: Optional[bool] = None,
                      reason: Optional[str] = None) -> Optional[APIKey]:
        """Update an existing API key."""
        db_key = self.get_api_key_by_id(db, key_id)
        if not db_key:
            return None
        
        # Track changes for history
        changes = []
        
        if name is not None and name != db_key.name:
            changes.append(("name", db_key.name, name))
            db_key.name = name
        
        if api_key is not None:
            encrypted_key = self._encrypt(api_key).decode('utf-8')
            changes.append(("key", db_key.encrypted_key, encrypted_key))
            db_key.encrypted_key = encrypted_key
        
        if hourly_quota is not None and hourly_quota != db_key.hourly_quota:
            changes.append(("hourly_quota", db_key.hourly_quota, hourly_quota))
            db_key.hourly_quota = hourly_quota
        
        if daily_quota is not None and daily_quota != db_key.daily_quota:
            changes.append(("daily_quota", db_key.daily_quota, daily_quota))
            db_key.daily_quota = daily_quota
        
        if is_active is not None and is_active != db_key.is_active:
            changes.append(("is_active", db_key.is_active, is_active))
            db_key.is_active = is_active
        
        if changes:
            db_key.updated_at = datetime.utcnow()
            db.commit()
            
            # Create history record
            action = "updated"
            if is_active is False:
                action = "deactivated"
            elif is_active is True and db_key.is_active:
                action = "activated"
            
            history_data = {
                "api_key_id": db_key.id,
                "action": action,
                "reason": reason or "Updated via API"
            }
            
            for field, old_val, new_val in changes:
                if field == "name":
                    history_data["previous_name"] = old_val
                    history_data["new_name"] = new_val
                elif field == "key":
                    history_data["previous_encrypted_key"] = old_val
                    history_data["new_encrypted_key"] = new_val
            
            history = APIKeyHistory(**history_data)
            db.add(history)
            db.commit()
        
        return db_key
    
    def delete_api_key(self, db: Session, key_id: str, reason: Optional[str] = None) -> bool:
        """Delete an API key."""
        db_key = self.get_api_key_by_id(db, key_id)
        if not db_key:
            return False
        
        # Create history record before deletion
        history = APIKeyHistory(
            api_key_id=db_key.id,
            action="deleted",
            previous_encrypted_key=db_key.encrypted_key,
            previous_name=db_key.name,
            reason=reason or "Deleted via API"
        )
        db.add(history)
        
        # Delete the key
        db.delete(db_key)
        db.commit()
        
        return True
    
    def get_decrypted_key(self, db_key: APIKey) -> str:
        """Decrypt an API key."""
        return self._decrypt(db_key.encrypted_key.encode('utf-8'))
    
    def get_active_key_for_service(self, db: Session, service: str) -> Optional[APIKey]:
        """Get the most recently used active API key for a service."""
        return db.query(APIKey).filter(
            and_(APIKey.service == service, APIKey.is_active == True)
        ).order_by(APIKey.last_used_at.desc().nullslast()).first()
    
    def track_api_usage(self, db: Session, key_id: str, request_count: int = 1, 
                        success: bool = True, response_time: Optional[float] = None):
        """Track API usage for quota management."""
        db_key = self.get_api_key_by_id(db, key_id)
        if not db_key:
            return
        
        now = datetime.utcnow()
        
        # Update last used timestamp
        db_key.last_used_at = now
        
        # Track usage for different periods
        for period_type in ['hour', 'day', 'month']:
            # Calculate period start
            if period_type == 'hour':
                period_start = now.replace(minute=0, second=0, microsecond=0)
            elif period_type == 'day':
                period_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            else:  # month
                period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            
            # Find or create usage record
            usage = db.query(APIKeyUsage).filter(
                and_(
                    APIKeyUsage.api_key_id == key_id,
                    APIKeyUsage.period_type == period_type,
                    APIKeyUsage.period_start == period_start
                )
            ).first()
            
            if not usage:
                usage = APIKeyUsage(
                    api_key_id=key_id,
                    period_type=period_type,
                    period_start=period_start
                )
                db.add(usage)
            
            # Update usage
            usage.requests_count += request_count
            if success:
                usage.success_count += request_count
            else:
                usage.error_count += request_count
            
            if response_time is not None:
                if usage.avg_response_time is None:
                    usage.avg_response_time = response_time
                else:
                    # Calculate new average
                    total_requests = usage.requests_count
                    usage.avg_response_time = (
                        (usage.avg_response_time * (total_requests - request_count) + response_time) / 
                        total_requests
                    )
            
            usage.updated_at = now
        
        db.commit()
    
    def get_usage_stats(self, db: Session, key_id: str) -> Dict:
        """Get usage statistics for a specific API key."""
        db_key = self.get_api_key_by_id(db, key_id)
        if not db_key:
            return {}
        
        now = datetime.utcnow()
        
        # Get current period usage
        hour_start = now.replace(minute=0, second=0, microsecond=0)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        
        hourly_usage = db.query(APIKeyUsage).filter(
            and_(
                APIKeyUsage.api_key_id == key_id,
                APIKeyUsage.period_type == 'hour',
                APIKeyUsage.period_start == hour_start
            )
        ).first()
        
        daily_usage = db.query(APIKeyUsage).filter(
            and_(
                APIKeyUsage.api_key_id == key_id,
                APIKeyUsage.period_type == 'day',
                APIKeyUsage.period_start == day_start
            )
        ).first()
        
        # Get total usage
        total_usage = db.query(func.sum(APIKeyUsage.requests_count)).filter(
            APIKeyUsage.api_key_id == key_id
        ).scalar() or 0
        
        # Calculate usage percentage
        hourly_requests = hourly_usage.requests_count if hourly_usage else 0
        daily_requests = daily_usage.requests_count if daily_usage else 0
        
        hourly_percentage = 0
        if db_key.hourly_quota > 0:
            hourly_percentage = min(100, (hourly_requests / db_key.hourly_quota) * 100)
        
        daily_percentage = 0
        if db_key.daily_quota > 0:
            daily_percentage = min(100, (daily_requests / db_key.daily_quota) * 100)
        
        # Time until reset
        time_until_reset = None
        if db_key.hourly_quota > 0:
            next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            time_until_reset = int((next_hour - now).total_seconds())
        
        return {
            "key_id": str(db_key.id),
            "name": db_key.name,
            "service": db_key.service,
            "is_active": db_key.is_active,
            "hourly_quota": db_key.hourly_quota,
            "daily_quota": db_key.daily_quota,
            "requests_this_hour": hourly_requests,
            "requests_today": daily_requests,
            "total_requests": total_usage,
            "hourly_usage_percentage": hourly_percentage,
            "daily_usage_percentage": daily_percentage,
            "time_until_reset": time_until_reset,
            "last_used_at": db_key.last_used_at.isoformat() if db_key.last_used_at else None
        }
    
    def is_rate_limited(self, db: Session, key_id: str) -> bool:
        """Check if an API key has reached its rate limit."""
        db_key = self.get_api_key_by_id(db, key_id)
        if not db_key or not db_key.is_active:
            return True
        
        if db_key.hourly_quota <= 0:
            return False  # No quota limit
        
        now = datetime.utcnow()
        hour_start = now.replace(minute=0, second=0, microsecond=0)
        
        hourly_usage = db.query(APIKeyUsage).filter(
            and_(
                APIKeyUsage.api_key_id == key_id,
                APIKeyUsage.period_type == 'hour',
                APIKeyUsage.period_start == hour_start
            )
        ).first()
        
        if not hourly_usage:
            return False
        
        return hourly_usage.requests_count >= db_key.hourly_quota
    
    def rotate_api_key(self, db: Session, key_id: str, new_key: str, reason: Optional[str] = None) -> bool:
        """Rotate an API key with a new one."""
        db_key = self.get_api_key_by_id(db, key_id)
        if not db_key:
            return False
        
        # Store old key for history
        old_encrypted_key = db_key.encrypted_key
        
        # Update with new key
        db_key.encrypted_key = self._encrypt(new_key).decode('utf-8')
        db_key.updated_at = datetime.utcnow()
        
        # Create history record
        history = APIKeyHistory(
            api_key_id=key_id,
            action="rotated",
            previous_encrypted_key=old_encrypted_key,
            new_encrypted_key=db_key.encrypted_key,
            reason=reason or "Key rotation"
        )
        db.add(history)
        db.commit()
        
        return True
    
    def test_api_key(self, db: Session, key_id: str) -> Tuple[bool, str]:
        """Test if an API key is valid."""
        db_key = self.get_api_key_by_id(db, key_id)
        if not db_key:
            return False, "API key not found"
        
        try:
            api_key = self.get_decrypted_key(db_key)
            # This is a placeholder - actual implementation would make a test request
            # to the specific API endpoint for each service
            return True, "API key appears valid (basic validation)"
        except Exception as e:
            return False, f"API key validation failed: {str(e)}"
    
    def get_key_history(self, db: Session, key_id: str) -> List[APIKeyHistory]:
        """Get the history of changes for an API key."""
        return db.query(APIKeyHistory).filter(
            APIKeyHistory.api_key_id == key_id
        ).order_by(APIKeyHistory.created_at.desc()).all()
    
    # Legacy methods for backward compatibility
    
    def add_api_key(self, source: str, api_key: str) -> bool:
        """Add or update an API key for a specific source (legacy method)."""
        if source not in get_media_source_config(source):
            return False
        
        self._api_keys[source] = api_key
        self._save_api_keys()
        return True
    
    def get_api_key(self, source: str) -> Optional[str]:
        """Get the current API key for a specific source (legacy method)."""
        return self._api_keys.get(source)
    
    def get_all_api_keys_masked(self) -> Dict[str, Optional[str]]:
        """Get all API keys (masked for security) (legacy method)."""
        masked_keys = {}
        for source, key in self._api_keys.items():
            if key:
                masked_keys[source] = f"{key[:8]}...{key[-4:]}" if len(key) > 12 else "****"
            else:
                masked_keys[source] = None
        return masked_keys
    
    def remove_api_key(self, source: str) -> bool:
        """Remove an API key for a specific source (legacy method)."""
        if source in self._api_keys:
            del self._api_keys[source]
            self._save_api_keys()
            return True
        return False
    
    def track_api_usage_legacy(self, source: str, request_count: int = 1):
        """Track API usage for quota management (legacy method)."""
        if source not in self._usage_data:
            self._usage_data[source] = {
                "requests_today": 0,
                "requests_this_hour": 0,
                "last_reset_date": datetime.now().strftime("%Y-%m-%d"),
                "last_reset_hour": datetime.now().strftime("%Y-%m-%d %H"),
                "total_requests": 0
            }
        
        now = datetime.now()
        current_date = now.strftime("%Y-%m-%d")
        current_hour = now.strftime("%Y-%m-%d %H")
        
        # Reset daily counter if needed
        if self._usage_data[source]["last_reset_date"] != current_date:
            self._usage_data[source]["requests_today"] = 0
            self._usage_data[source]["last_reset_date"] = current_date
        
        # Reset hourly counter if needed
        if self._usage_data[source]["last_reset_hour"] != current_hour:
            self._usage_data[source]["requests_this_hour"] = 0
            self._usage_data[source]["last_reset_hour"] = current_hour
        
        # Update counters
        self._usage_data[source]["requests_today"] += request_count
        self._usage_data[source]["requests_this_hour"] += request_count
        self._usage_data[source]["total_requests"] += request_count
        
        self._save_usage_data()
    
    def get_usage_stats_legacy(self, source: str) -> Dict:
        """Get usage statistics for a specific source (legacy method)."""
        if source not in self._usage_data:
            return {
                "requests_today": 0,
                "requests_this_hour": 0,
                "total_requests": 0,
                "hourly_limit": 0,
                "daily_limit": 0,
                "usage_percentage": 0
            }
        
        source_config = get_media_source_config(source)
        hourly_limit = source_config.get("rate_limit", 0) if source_config else 0
        
        usage_data = self._usage_data[source]
        usage_percentage = (usage_data["requests_this_hour"] / hourly_limit * 100) if hourly_limit > 0 else 0
        
        return {
            "requests_today": usage_data["requests_today"],
            "requests_this_hour": usage_data["requests_this_hour"],
            "total_requests": usage_data["total_requests"],
            "hourly_limit": hourly_limit,
            "daily_limit": hourly_limit * 24,  # Estimate
            "usage_percentage": min(usage_percentage, 100)
        }
    
    def is_rate_limited_legacy(self, source: str) -> bool:
        """Check if a source has reached its rate limit (legacy method)."""
        source_config = get_media_source_config(source)
        if not source_config:
            return True
        
        hourly_limit = source_config.get("rate_limit", 0)
        if hourly_limit <= 0:
            return False
        
        if source not in self._usage_data:
            return False
        
        return self._usage_data[source]["requests_this_hour"] >= hourly_limit
    
    def get_time_until_reset_legacy(self, source: str) -> Optional[int]:
        """Get seconds until the next rate limit reset for a source (legacy method)."""
        if source not in self._usage_data:
            return None
        
        now = datetime.now()
        next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        return int((next_hour - now).total_seconds())
    
    def test_api_key_legacy(self, source: str) -> Tuple[bool, str]:
        """Test if an API key is valid for a specific source (legacy method)."""
        api_key = self.get_api_key(source)
        if not api_key:
            return False, "No API key configured"
        
        # This is a placeholder - actual implementation would make a test request
        # to the specific API endpoint for each source
        return True, "API key appears valid (basic validation)"
    
    def rotate_api_key_legacy(self, source: str, new_key: str) -> bool:
        """Rotate an API key with a new one (legacy method)."""
        if self.add_api_key(source, new_key):
            # Reset usage counters for the source
            if source in self._usage_data:
                self._usage_data[source]["requests_this_hour"] = 0
                self._usage_data[source]["last_reset_hour"] = datetime.now().strftime("%Y-%m-%d %H")
                self._save_usage_data()
            return True
        return False


# Global instance
api_key_manager = APIKeyManager()