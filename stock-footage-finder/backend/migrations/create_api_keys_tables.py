"""
Migration script to create API key management tables.
"""

import os
import sys
from datetime import datetime

# Add the parent directory to the path so we can import our modules
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from database import init_database, get_database_url
from models.api_keys import Base, APIKey, APIKeyUsage, APIKeyHistory
from services.api_key_manager import api_key_manager
from config import get_all_media_sources


def create_tables():
    """Create all API key management tables."""
    print("Creating API key management tables...")
    
    # Initialize the database
    init_database()
    
    print("Tables created successfully!")
    print("Created tables:")
    print("- api_keys: Stores encrypted API keys for different services")
    print("- api_key_usage: Tracks usage statistics for API keys")
    print("- api_key_history: Maintains audit trail of key changes")


def add_sample_data():
    """Add sample data for testing purposes."""
    from database import SessionLocal
    
    print("Adding sample data...")
    
    db = SessionLocal()
    
    try:
        # Check if we already have data
        existing_keys = db.query(APIKey).count()
        if existing_keys > 0:
            print(f"Found {existing_keys} existing API keys. Skipping sample data creation.")
            return
        
        # Get all available media sources
        media_sources = get_all_media_sources()
        
        # Create sample API keys for each service
        sample_keys = [
            {
                "name": "Pexels Production Key",
                "service": "pexels",
                "api_key": "sample_pexels_key_1234567890abcdef",
                "hourly_quota": 200,
                "daily_quota": 4800
            },
            {
                "name": "Pixabay Production Key",
                "service": "pixabay",
                "api_key": "sample_pixabay_key_1234567890abcdef",
                "hourly_quota": 100,
                "daily_quota": 2400
            },
            {
                "name": "Unsplash Production Key",
                "service": "unsplash",
                "api_key": "sample_unsplash_key_1234567890abcdef",
                "hourly_quota": 50,
                "daily_quota": 1200
            },
            {
                "name": "Videvo Production Key",
                "service": "videvo",
                "api_key": "sample_videvo_key_1234567890abcdef",
                "hourly_quota": 100,
                "daily_quota": 2400
            }
        ]
        
        for key_data in sample_keys:
            if key_data["service"] in media_sources:
                # Encrypt the API key
                encrypted_key = api_key_manager._encrypt(key_data["api_key"]).decode('utf-8')
                
                # Create the API key
                db_key = APIKey(
                    name=key_data["name"],
                    service=key_data["service"],
                    encrypted_key=encrypted_key,
                    hourly_quota=key_data["hourly_quota"],
                    daily_quota=key_data["daily_quota"],
                    is_active=True
                )
                
                db.add(db_key)
                db.flush()  # Get the ID without committing
                
                # Create a history record
                history = APIKeyHistory(
                    api_key_id=db_key.id,
                    action="created",
                    new_encrypted_key=encrypted_key,
                    new_name=key_data["name"],
                    reason="Sample data creation"
                )
                
                db.add(history)
                
                print(f"Created sample API key for {key_data['service']}")
        
        # Commit all changes
        db.commit()
        print("Sample data added successfully!")
        
    except Exception as e:
        print(f"Error adding sample data: {e}")
        db.rollback()
    finally:
        db.close()


def migrate_legacy_keys():
    """Migrate legacy file-based API keys to the database."""
    from database import SessionLocal
    
    print("Migrating legacy API keys...")
    
    db = SessionLocal()
    
    try:
        # Load legacy keys
        api_key_manager._load_api_keys()
        legacy_keys = api_key_manager._api_keys
        
        if not legacy_keys:
            print("No legacy API keys found to migrate.")
            return
        
        migrated_count = 0
        
        for service, key in legacy_keys.items():
            if not key:  # Skip empty keys
                continue
                
            # Check if we already have a key for this service
            existing_key = db.query(APIKey).filter(
                APIKey.service == service
            ).first()
            
            if existing_key:
                print(f"API key for {service} already exists in database. Skipping migration.")
                continue
            
            # Get service configuration for quota limits
            media_sources = get_all_media_sources()
            service_config = media_sources.get(service, {})
            hourly_quota = service_config.get("rate_limit", 0)
            
            # Encrypt the API key
            encrypted_key = api_key_manager._encrypt(key).decode('utf-8')
            
            # Create the API key
            db_key = APIKey(
                name=f"Migrated {service.title()} Key",
                service=service,
                encrypted_key=encrypted_key,
                hourly_quota=hourly_quota,
                daily_quota=hourly_quota * 24 if hourly_quota > 0 else 0,
                is_active=True
            )
            
            db.add(db_key)
            db.flush()  # Get the ID without committing
            
            # Create a history record
            history = APIKeyHistory(
                api_key_id=db_key.id,
                action="created",
                new_encrypted_key=encrypted_key,
                new_name=db_key.name,
                reason="Migrated from file-based storage"
            )
            
            db.add(history)
            migrated_count += 1
            print(f"Migrated API key for {service}")
        
        # Commit all changes
        db.commit()
        print(f"Successfully migrated {migrated_count} API keys to database!")
        
    except Exception as e:
        print(f"Error migrating legacy keys: {e}")
        db.rollback()
    finally:
        db.close()


def backup_legacy_data():
    """Create a backup of legacy data before migration."""
    import shutil
    
    print("Creating backup of legacy data...")
    
    backup_dir = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    os.makedirs(backup_dir, exist_ok=True)
    
    files_to_backup = [
        "api_keys.enc",
        "api_usage.json",
        "encryption.key"
    ]
    
    for file in files_to_backup:
        if os.path.exists(file):
            shutil.copy2(file, backup_dir)
            print(f"Backed up {file}")
    
    print(f"Legacy data backed up to {backup_dir}/")


def main():
    """Main migration function."""
    print("=" * 60)
    print("Stock Footage Finder - API Key Management Migration")
    print("=" * 60)
    
    # Create backup of legacy data
    backup_legacy_data()
    
    # Create tables
    create_tables()
    
    # Migrate legacy keys if they exist
    migrate_legacy_keys()
    
    # Add sample data for testing
    add_sample_data()
    
    print("\nMigration completed successfully!")
    print("\nDatabase URL:", get_database_url())
    print("\nYou can now start the application with:")
    print("python -m uvicorn main:app --reload")


if __name__ == "__main__":
    main()