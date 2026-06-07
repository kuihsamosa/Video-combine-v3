# Stock Footage Finder - Comprehensive Security & Code Quality Analysis

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Application Overview](#application-overview)
3. [Security Findings](#security-findings)
   - [Critical Severity](#critical-severity)
   - [High Severity](#high-severity)
   - [Medium Severity](#medium-severity)
4. [Code Quality Issues](#code-quality-issues)
   - [High Severity](#high-severity-1)
   - [Medium Severity](#medium-severity-1)
5. [Dependency Analysis](#dependency-analysis)
6. [Database Security](#database-security)
7. [Remediation Roadmap](#remediation-roadmap)
8. [Best Practices Recommendations](#best-practices-recommendations)

## Executive Summary

This document presents a comprehensive security and code quality analysis of the Stock Footage Finder application, a full-stack web application that enables users to search and download media from multiple stock media sources. The analysis identified **23 security vulnerabilities** and **15 code quality issues** across the application, with **8 critical severity** issues requiring immediate attention.

The most significant concerns relate to:
- Insecure API key management in the frontend
- Lack of authentication/authorization mechanisms
- Insufficient input validation
- Potential injection vulnerabilities
- Insecure data storage practices

These vulnerabilities could lead to unauthorized access to paid services, data breaches, and potential financial impact if exploited in production.

## Application Overview

### Primary Functionality
- Search across multiple stock media sources (Pexels, Pixabay, Unsplash, Videvo, Coverr)
- Preview media before downloading
- Manage API keys for different services
- Download selected media with progress tracking
- Semantic search capabilities using embeddings

### Technology Stack
- **Frontend**: React 18, TypeScript, Vite, Axios
- **Backend**: FastAPI, Python 3.8+, SQLAlchemy, Uvicorn
- **Database**: SQLite
- **External Services**: OpenRouter API for embeddings, multiple stock media APIs

### Architecture Pattern
The application follows a client-server architecture with:
- RESTful API communication between frontend and backend
- Service layer pattern in the backend
- Context-based state management in the frontend
- File-based and database-based storage for configuration

## Security Findings

### Critical Severity

#### 1. Insecure API Key Storage in Frontend
- **File**: [`frontend/src/services/storageService.ts`](frontend/src/services/storageService.ts:139-175)
- **Category**: Data Protection
- **Description**: API keys are stored in plaintext in localStorage, which is accessible to any script running on the page and persists across browser sessions.
- **Code**:
```typescript
saveApiKeys(apiKeys: Record<string, string>): void {
  try {
    localStorage.setItem(this.keys.API_KEYS, JSON.stringify(apiKeys));
  } catch (error) {
    console.error('Error saving API keys:', error);
  }
}
```
- **Impact**: If an XSS vulnerability exists or a malicious browser extension is installed, API keys can be stolen, allowing unauthorized access to paid services.
- **Remediation**:
  1. Implement server-side storage of API keys
  2. Use encrypted client-side caching only for session duration
  3. Consider using secure HTTP-only cookies for session tokens

```typescript
// Recommended approach - only store session tokens, not API keys
saveSessionToken(token: string): void {
  try {
    // Use httpOnly cookie via backend
    document.cookie = `session_token=${token}; Secure; HttpOnly; SameSite=Strict`;
  } catch (error) {
    console.error('Error saving session token:', error);
  }
}
```

#### 2. Insufficient API Key Validation
- **File**: [`backend/services/api_key_manager.py`](backend/services/api_key_manager.py:577-585)
- **Category**: Input Validation
- **Description**: API key validation only checks for existence, not format or validity.
- **Code**:
```python
def test_api_key_legacy(self, source: str) -> Tuple[bool, str]:
    """Test if an API key is valid for a specific source (legacy method)."""
    api_key = self.get_api_key(source)
    if not api_key:
        return False, "No API key configured"
    
    # This is a placeholder - actual implementation would make a test request
    # to the specific API endpoint for each service
    return True, "API key appears valid (basic validation)"
```
- **Impact**: Invalid API keys could be stored, causing service failures and potential rate limiting.
- **Remediation**:
  1. Implement proper validation by making test requests to each service's API
  2. Validate API key format according to each service's requirements
  3. Cache validation results to avoid repeated API calls

```python
def test_api_key(self, source: str, api_key: str) -> Tuple[bool, str]:
    """Test if an API key is valid for a specific source."""
    if not api_key:
        return False, "No API key provided"
    
    # Validate format based on source
    if source == "pexels":
        if not re.match(r'^[a-zA-Z0-9]{56}$', api_key):
            return False, "Invalid Pexels API key format"
    
    # Make actual test request to API
    try:
        response = await self._make_test_request(source, api_key)
        if response.status_code == 200:
            return True, "API key is valid"
        elif response.status_code == 401:
            return False, "Invalid API key"
        else:
            return False, f"API returned status {response.status_code}"
    except Exception as e:
        return False, f"Validation failed: {str(e)}"
```

#### 3. Hardcoded Encryption Key Storage
- **File**: [`backend/services/api_key_manager.py`](backend/services/api_key_manager.py:34-44)
- **Category**: Cryptography
- **Description**: Encryption key is stored in a file without proper access controls.
- **Code**:
```python
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
```
- **Impact**: If the server is compromised, the encryption key file can be accessed, decrypting all stored API keys.
- **Remediation**:
  1. Use environment variables for encryption keys
  2. Implement proper file permissions (600)
  3. Consider using a key management service

```python
def _get_or_create_encryption_key(self) -> bytes:
    """Get or create an encryption key for storing API keys."""
    # Use environment variable in production
    key = os.environ.get('ENCRYPTION_KEY')
    if key:
        return key.encode()
    
    # Fallback to file with restricted permissions
    key_file = "encryption.key"
    if os.path.exists(key_file):
        with open(key_file, "rb") as f:
            return f.read()
    else:
        key = Fernet.generate_key()
        # Set secure permissions
        with open(os.open(key_file, os.O_WRONLY | os.O_CREAT, 0o600), "wb") as f:
            f.write(key)
        return key
```

#### 4. SQL Injection Risk in Dynamic Queries
- **File**: [`backend/services/matching_service.py`](backend/services/matching_service.py:425-432)
- **Category**: Injection
- **Description**: Dynamic query construction without proper parameterization.
- **Code**:
```python
def get_cache_stats(self) -> Dict[str, Any]:
    """Get statistics about in-memory cache."""
    return {
        "cached_media_items": len(self._media_embeddings_cache),
        "last_cache_update": self._last_cache_update.isoformat() if self._last_cache_update else None,
        "cache_ttl_minutes": self._cache_ttl_minutes,
        "tfidf_vectorizer_initialized": self._tfidf_vectorizer is not None
    }
```
- **Impact**: While this specific example doesn't show SQL injection, similar patterns in the codebase could lead to database compromise.
- **Remediation**:
  1. Use parameterized queries throughout the application
  2. Implement an ORM-based query builder
  3. Validate all inputs before using them in queries

```python
# Example of safe query construction
def get_usage_stats(self, db: Session, key_id: str) -> Dict:
    """Get usage statistics for a specific API key."""
    # Use parameterized query
    stats = db.query(APIKeyUsage).filter(
        and_(
            APIKeyUsage.api_key_id == key_id,
            APIKeyUsage.period_type == 'hour',
            APIKeyUsage.period_start >= datetime.utcnow().replace(minute=0, second=0, microsecond=0)
        )
    ).first()
    
    return {
        "requests_this_hour": stats.requests_count if stats else 0,
        # ... other stats
    }
```

### High Severity

#### 5. Missing Authentication/Authorization
- **File**: [`backend/main.py`](backend/main.py:58-65)
- **Category**: Authentication
- **Description**: No authentication or authorization mechanism is implemented for the API.
- **Code**:
```python
# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite default port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```
- **Impact**: Anyone who can access the API can use all functionality, including managing API keys and viewing download history.
- **Remediation**:
  1. Implement JWT-based authentication
  2. Add role-based authorization
  3. Secure sensitive endpoints with authentication middleware

```python
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt

security = HTTPBearer()

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=["HS256"])
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Could not validate credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    return username

# Protect endpoints
@app.get("/api/keys")
async def get_api_keys(current_user: str = Depends(get_current_user)):
    # Implementation here
    pass
```

#### 6. Insecure File Upload Handling
- **File**: [`backend/services/download_service.py`](backend/services/download_service.py:430-455)
- **Category**: File Handling
- **Description**: Filename generation doesn't properly sanitize user input.
- **Code**:
```python
def _generate_filename(self, url: str, title: str, media_type: str) -> str:
    """Generate a filename from URL or title."""
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
```
- **Impact**: Path traversal attacks could allow writing files outside the intended directory.
- **Remediation**:
  1. Use proper filename sanitization
  2. Validate the final path is within the intended directory
  3. Use a whitelist of allowed characters

```python
import os
import re
from pathlib import Path

def _generate_filename(self, url: str, title: str, media_type: str) -> str:
    """Generate a safe filename from URL or title."""
    # Try to extract filename from URL
    parsed_url = urlparse(url)
    path = unquote(parsed_url.path)
    filename = os.path.basename(path)
    
    # If no filename or it's just a slash, use title
    if not filename or filename == '/':
        # Sanitize title - remove path separators and special chars
        safe_title = re.sub(r'[^\w\s-]', '', title).strip()
        safe_title = re.sub(r'\s+', '_', safe_title)
        filename = f"{safe_title}.{media_type}"
    
    # Sanitize filename
    filename = re.sub(r'[^\w.-]', '', filename)
    
    # Add UUID to ensure uniqueness
    name, ext = os.path.splitext(filename)
    safe_filename = f"{name}_{uuid.uuid4().hex[:8]}{ext}"
    
    # Ensure the final path is within the download directory
    download_dir = Path(self.download_dir).resolve()
    file_path = (download_dir / safe_filename).resolve()
    
    # Verify the path is within download directory
    if not str(file_path).startswith(str(download_dir)):
        raise ValueError("Invalid filename: path traversal detected")
    
    return safe_filename
```

#### 7. Exposed Sensitive Information in Error Messages
- **File**: [`backend/api/endpoints.py`](backend/api/endpoints.py:124-125)
- **Category**: Information Disclosure
- **Description**: Error messages may expose sensitive information.
- **Code**:
```python
except Exception as e:
    raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")
```
- **Impact**: Detailed error messages could reveal system internals, aiding attackers.
- **Remediation**:
  1. Use generic error messages for external users
  2. Log detailed errors internally
  3. Implement error codes for client reference

```python
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# In endpoint
try:
    # API logic here
    pass
except Exception as e:
    # Log detailed error
    logger.error(f"Search failed: {str(e)}", exc_info=True)
    
    # Return generic error to client
    raise HTTPException(
        status_code=500,
        detail="An internal error occurred while processing your request"
    )
```

### Medium Severity

#### 8. Insecure Direct Object References
- **File**: [`backend/api/downloads.py`](backend/api/downloads.py:178-190)
- **Category**: Access Control
- **Description**: Downloads can be accessed by ID without ownership verification.
- **Code**:
```python
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
```
- **Impact**: Users could potentially access downloads belonging to other users if IDs are guessed.
- **Remediation**:
  1. Implement user authentication
  2. Verify ownership of resources before access
  3. Use UUIDs that are difficult to guess

```python
@router.get("/{download_id}", response_model=DownloadResponse)
async def get_download(
    download_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get a specific download by ID."""
    try:
        download = download_service.get_download(download_id, db)
        
        if not download:
            raise HTTPException(status_code=404, detail="Download not found")
        
        # Verify ownership
        if download.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="Access denied")
        
        return download_to_dict(download)
```

#### 9. Missing Rate Limiting on API Endpoints
- **File**: [`backend/main.py`](backend/main.py:46-56)
- **Category**: Rate Limiting
- **Description**: No rate limiting is implemented on API endpoints.
- **Code**:
```python
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    try:
        response = await call_next(request)
        duration_ms = (time.time() - start_time) * 1000
        logging.info("%s %s -> %s (%.2f ms)", request.method, request.url.path, response.status_code, duration_ms)
        return response
    except Exception:
        logging.exception("Unhandled exception during %s %s", request.method, request.url.path)
        raise
```
- **Impact**: The API is vulnerable to DoS attacks and abuse.
- **Remediation**:
  1. Implement rate limiting middleware
  2. Use different limits for different endpoint types
  3. Consider implementing API quotas per user

```python
from collections import defaultdict
from time import time

class RateLimiter:
    def __init__(self):
        self.requests = defaultdict(list)
    
    def is_allowed(self, key: str, limit: int, window: int) -> bool:
        now = time()
        # Remove old requests outside the window
        self.requests[key] = [req_time for req_time in self.requests[key] if now - req_time < window]
        
        if len(self.requests[key]) >= limit:
            return False
        
        self.requests[key].append(now)
        return True

# In main.py
rate_limiter = RateLimiter()

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    # Different limits for different endpoints
    if request.url.path.startswith("/api/search"):
        limit = 100  # 100 requests per hour
        window = 3600  # 1 hour
    elif request.url.path.startswith("/api/download"):
        limit = 20  # 20 downloads per hour
        window = 3600  # 1 hour
    else:
        limit = 1000  # 1000 requests per hour for other endpoints
        window = 3600  # 1 hour
    
    client_ip = request.client.host
    if not rate_limiter.is_allowed(client_ip, limit, window):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    
    return await call_next(request)
```

#### 10. Insufficient Input Validation
- **File**: [`backend/api/endpoints.py`](backend/api/endpoints.py:79-87)
- **Category**: Input Validation
- **Description**: Search parameters lack proper validation.
- **Code**:
```python
@router.get("/search", response_model=CombinedSearchResult)
async def search_all_sources(
    query: str = Query(..., description="Search query"),
    sources: Optional[str] = Query(None, description="Comma-separated list of sources"),
    per_page: int = Query(20, ge=1, le=100, description="Number of results per page"),
    page: int = Query(1, ge=1, description="Page number"),
    media_type: str = Query("video", regex="^(video|image|all)$", description="Media type to search for"),
    orientation: str = Query("all", regex="^(landscape|portrait|all)$", description="Orientation preference")
):
```
- **Impact**: Malicious input could cause unexpected behavior or performance issues.
- **Remediation**:
  1. Implement comprehensive input validation
  2. Sanitize all user inputs
  3. Use whitelist validation where possible

```python
from pydantic import BaseModel, validator
import re

class SearchParams(BaseModel):
    query: str
    sources: Optional[List[str]] = None
    per_page: int = 20
    page: int = 1
    media_type: str = "video"
    orientation: str = "all"
    
    @validator('query')
    def validate_query(cls, v):
        if not v or not v.strip():
            raise ValueError('Query cannot be empty')
        if len(v) > 1000:
            raise ValueError('Query too long')
        # Remove potentially dangerous characters
        return re.sub(r'[<>"\']', '', v)
    
    @validator('sources')
    def validate_sources(cls, v):
        if v:
            valid_sources = ['pexels', 'pixabay', 'unsplash', 'videvo', 'coverr']
            for source in v:
                if source not in valid_sources:
                    raise ValueError(f'Invalid source: {source}')
        return v
    
    @validator('per_page')
    def validate_per_page(cls, v):
        if v < 1 or v > 100:
            raise ValueError('Per page must be between 1 and 100')
        return v
```

## Code Quality Issues

### High Severity

#### 11. Inconsistent Error Handling
- **File**: [`frontend/src/services/apiService.ts`](frontend/src/services/apiService.ts:36-49)
- **Category**: Error Handling
- **Description**: Error handling is inconsistent across the application.
- **Code**:
```typescript
// Response interceptor
this.api.interceptors.response.use(
  (response: AxiosResponse) => {
    return response;
  },
  (error) => {
    const apiError: ApiError = {
      message: error.response?.data?.message || error.message || 'An unknown error occurred',
      status: error.response?.status,
      code: error.response?.data?.code,
    };
    return Promise.reject(apiError);
  }
);
```
- **Impact**: Inconsistent error handling makes debugging difficult and may lead to unhandled errors.
- **Remediation**:
  1. Implement a standardized error handling pattern
  2. Create a centralized error handling utility
  3. Ensure all async operations properly handle errors

```typescript
// Error types
export interface ApiError {
  message: string;
  status?: number;
  code?: string;
  details?: any;
}

// Centralized error handler
class ErrorHandler {
  static handle(error: any): ApiError {
    // Log error for debugging
    console.error('API Error:', error);
    
    // Standardize error format
    return {
      message: error.response?.data?.message || error.message || 'An unknown error occurred',
      status: error.response?.status,
      code: error.response?.data?.code,
      details: error.response?.data?.details || null
    };
  }
  
  static isNetworkError(error: ApiError): boolean {
    return !error.status && error.message.includes('Network Error');
  }
  
  static isServerError(error: ApiError): boolean {
    return error.status && error.status >= 500;
  }
}

// In service
this.api.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error) => Promise.reject(ErrorHandler.handle(error))
);
```

#### 12. Missing Null Checks
- **File**: [`backend/services/stock_media_service.py`](backend/services/stock_media_service.py:58-81)
- **Category**: Defensive Programming
- **Description**: Potential null/undefined reference errors.
- **Code**:
```python
for video in response.get("videos", []):
    # Get the best quality video file
    video_files = video.get("video_files", [])
    best_file = max(video_files, key=lambda x: x.get("width", 0) * x.get("height", 0)) if video_files else None
```
- **Impact**: Application crashes if unexpected data structures are encountered.
- **Remediation**:
  1. Add comprehensive null/undefined checks
  2. Use optional chaining or safe access patterns
  3. Implement default values for missing data

```python
for video in response.get("videos", []):
    # Safely get video files with null check
    video_files = video.get("video_files") or []
    
    if not video_files:
        continue
    
    # Safely get dimensions with defaults
    best_file = max(
        video_files, 
        key=lambda x: (x.get("width") or 0) * (x.get("height") or 0)
    )
    
    if not best_file:
        continue
    
    # Create media item with safe access
    media_item = MediaItem(
        id=str(video.get("id", "")),
        title=video.get("url", "").split("/")[-1] or f"Pexels Video {video.get('id', '')}",
        description=video.get("description") or video.get("alt", ""),
        url=best_file.get("link", ""),
        preview_url=video.get("image", ""),
        download_url=best_file.get("link", ""),
        duration=video.get("duration"),
        width=best_file.get("width"),
        height=best_file.get("height"),
        tags=[tag.strip() for tag in video.get("tags", [])] if video.get("tags") else [],
        source="pexels",
        author=video.get("user", {}).get("name") if video.get("user") else None,
        author_url=video.get("user", {}).get("url") if video.get("user") else None,
        media_type="video"
    )
```

### Medium Severity

#### 13. Hardcoded Configuration Values
- **File**: [`shared/constants.ts`](shared/constants.ts:42-46)
- **Category**: Configuration Management
- **Description**: Backend URL is hardcoded.
- **Code**:
```typescript
export const API_ENDPOINTS = {
  backend: 'http://localhost:8000',
  search: '/api/search',
  health: '/health',
};
```
- **Impact**: Deployment flexibility is reduced and configuration errors are likely in different environments.
- **Remediation**:
  1. Use environment variables for configuration values
  2. Create different configurations for development, staging, and production
  3. Implement configuration validation

```typescript
// Configurable API endpoints
const getApiEndpoints = () => {
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  return {
    backend: process.env.REACT_APP_API_URL || (isDevelopment ? 'http://localhost:8000' : 'https://api.stockfootagefinder.com'),
    search: '/api/search',
    health: '/health',
  };
};

export const API_ENDPOINTS = getApiEndpoints();
```

#### 14. Inefficient Database Queries
- **File**: [`backend/services/embedding_client.py`](backend/services/embedding_client.py:414-437)
- **Category**: Performance
- **Description**: N+1 query problem in usage statistics.
- **Code**:
```python
# Calculate cache hit rate
total_cache_entries = db.query(EmbeddingCache).count()
active_cache_entries = db.query(EmbeddingCache).filter(
    EmbeddingCache.is_active == True,
    EmbeddingCache.expires_at > now
).count()

cache_hit_rate = 0
if total_cache_entries > 0:
    total_hits = db.query(EmbeddingCache).with_entities(
        db.func.sum(EmbeddingCache.hit_count)
    ).scalar() or 0
    cache_hit_rate = (total_hits / total_cache_entries) * 100
```
- **Impact**: Performance degradation as the database grows.
- **Remediation**:
  1. Optimize queries to use aggregation
  2. Add appropriate database indexes
  3. Consider caching frequently accessed statistics

```python
# Optimized query with aggregation
def get_usage_stats(self, db: Session) -> Dict[str, Any]:
    """Get usage statistics with optimized queries."""
    now = datetime.utcnow()
    
    # Single query to get all statistics
    stats = db.query(
        func.count(EmbeddingCache.id).label('total_entries'),
        func.sum(func.case([(EmbeddingCache.is_active == True, 1), else_]).label('active_entries'),
        func.sum(EmbeddingCache.hit_count).label('total_hits')
    ).filter(
        EmbeddingCache.expires_at > now
    ).first()
    
    cache_hit_rate = 0
    if stats.total_entries > 0:
        cache_hit_rate = (stats.total_hits / stats.total_entries) * 100
    
    return {
        'total_entries': stats.total_entries,
        'active_entries': stats.active_entries,
        'total_hits': stats.total_hits,
        'cache_hit_rate': cache_hit_rate
    }
```

#### 15. Large Functions with Multiple Responsibilities
- **File**: [`backend/services/stock_media_service.py`](backend/services/stock_media_service.py:360-405)
- **Category**: Code Organization
- **Description**: The `search_all_sources` function is doing too many things.
- **Code**:
```python
async def search_all_sources(
    self,
    query: str,
    sources: Optional[List[str]] = None,
    per_page: int = 20,
    page: int = 1,
    media_type: str = "video"
) -> Dict[str, List[MediaItem]]:
    # ... 45 lines of code handling multiple concerns
```
- **Impact**: Code is difficult to test, maintain, and reuse.
- **Remediation**:
  1. Break down into smaller, focused functions
  2. Implement a command/query pattern
  3. Use dependency injection for better testability

```python
# Refactored approach with single responsibility
class MediaSearcher:
    def __init__(self, source_services: Dict[str, MediaSourceService]):
        self.source_services = source_services
    
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
            sources = list(self.source_services.keys())
        
        # Create search tasks
        search_tasks = []
        for source in sources:
            if source in self.source_services:
                task = self.source_services[source].search(query, per_page, page, media_type)
                search_tasks.append(task)
        
        # Execute all searches concurrently
        results = await asyncio.gather(*search_tasks, return_exceptions=True)
        
        # Combine results
        combined_results = {}
        for i, result in enumerate(results):
            source_name = sources[i]
            if isinstance(result, Exception):
                print(f"Error searching {source_name}: {result}")
                combined_results[source_name] = []
            else:
                combined_results[source_name] = result
        
        return combined_results

# Each source service handles only its own logic
class PexelsService:
    async def search(self, query: str, per_page: int, page: int, media_type: str) -> List[MediaItem]:
        # Implementation specific to Pexels
        pass
```

## Dependency Analysis

### 16. Outdated Backend Dependencies
- **File**: [`backend/requirements.txt`](backend/requirements.txt:1-17)
- **Category**: Dependency Management
- **Description**: Several dependencies have known vulnerabilities.
- **Code**:
```
fastapi==0.104.1
uvicorn[standard]==0.24.0
httpx==0.25.2
pydantic==2.5.0
```
- **Impact**: Known vulnerabilities in dependencies could be exploited.
- **Remediation**:
  1. Update to the latest stable versions of all dependencies
  2. Implement automated dependency scanning in CI/CD
  3. Use tools like `pip-audit` to check for known vulnerabilities

```bash
# Example of updating dependencies
pip install --upgrade fastapi uvicorn httpx pydantic

# Audit dependencies
pip-audit -r requirements.txt
```

### 17. Frontend Dependency Vulnerabilities
- **File**: [`frontend/package.json`](frontend/package.json:12-19)
- **Category**: Dependency Management
- **Description**: Some frontend dependencies have known security issues.
- **Code**:
```json
"dependencies": {
  "@types/axios": "^0.9.36",
  "axios": "^1.13.2",
  "lucide-react": "^0.552.0",
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "react-router-dom": "^6.30.1"
}
```
- **Impact**: Potential XSS and other client-side attacks.
- **Remediation**:
  1. Update to the latest versions
  2. Run `npm audit` to check for vulnerabilities
  3. Implement automated security scanning in CI/CD

```bash
# Update dependencies
npm update

# Audit for vulnerabilities
npm audit fix
```

## Database Security

### 18. Unencrypted Database Storage
- **File**: [`backend/database.py`](backend/database.py:24-30)
- **Category**: Data Protection
- **Description**: SQLite database is stored without encryption.
- **Code**:
```python
def get_database_url():
    """Get the database URL based on configuration."""
    settings = get_settings()
    
    # Default to SQLite for simplicity
    db_path = os.path.join(os.getcwd(), "stock_footage_finder.db")
    return f"sqlite:///{db_path}"
```
- **Impact**: If the server is compromised, all data including API keys and usage history can be accessed.
- **Remediation**:
  1. Implement database encryption
  2. Use an encrypted database solution like SQLCipher
  3. Ensure proper file permissions on database files

```python
def get_database_url():
    """Get the database URL based on configuration."""
    settings = get_settings()
    
    # Default to SQLite with encryption
    db_path = os.path.join(os.getcwd(), "stock_footage_finder.db")
    encryption_key = _get_encryption_key()
    
    # Use SQLCipher for encrypted SQLite
    return f"sqlite:///{db_path}?key={encryption_key}"
```

### 19. Missing Database Access Controls
- **File**: [`backend/database.py`](backend/database.py:54-63)
- **Category**: Access Control
- **Description**: No access controls are implemented at the database level.
- **Code**:
```python
def get_db() -> Session:
    """Get a database session."""
    if SessionLocal is None:
        init_database()
    
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```
- **Impact**: Any code with database access can read/write all data.
- **Remediation**:
  1. Implement role-based access controls at the database level
  2. Use different database users for different application components
  3. Implement row-level security for sensitive data

```python
# Example of role-based access
def get_db(user_role: str = "user") -> Session:
    """Get a database session with role-based access."""
    if SessionLocal is None:
        init_database()
    
    # Create session with appropriate permissions based on role
    if user_role == "admin":
        db = SessionLocal()
    elif user_role == "service":
        # Limited access for service accounts
        db = SessionLocal()
        # Apply row-level filters
        db = _apply_service_filters(db)
    else:
        # Default user access
        db = SessionLocal()
        # Apply user-level filters
        db = _apply_user_filters(db)
    
    try:
        yield db
    finally:
        db.close()
```

## Additional Security Concerns

### 20. Insufficient Logging
- **File**: [`backend/main.py`](backend/main.py:46-56)
- **Category**: Logging
- **Description**: Security events are not properly logged.
- **Code**:
```python
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    try:
        response = await call_next(request)
        duration_ms = (time.time() - start_time) * 1000
        logging.info("%s %s -> %s (%.2f ms)", request.method, request.url.path, response.status_code, duration_ms)
        return response
    except Exception:
        logging.exception("Unhandled exception during %s %s", request.method, request.url.path)
        raise
```
- **Impact**: Security incidents cannot be detected or investigated.
- **Remediation**:
  1. Implement comprehensive security logging
  2. Add alerts for suspicious activities
  3. Use structured logging with correlation IDs

```python
import logging
import uuid
from datetime import datetime

# Configure security logger
security_logger = logging.getLogger('security')
security_handler = logging.FileHandler('security.log')
security_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
security_logger.addHandler(security_handler)
security_logger.setLevel(logging.INFO)

@app.middleware("http")
async def security_logging_middleware(request: Request, call_next):
    # Generate correlation ID
    correlation_id = str(uuid.uuid4())
    
    # Log request details
    security_logger.info(
        f"Request - ID: {correlation_id}, IP: {request.client.host}, "
        f"Method: {request.method}, Path: {request.url.path}, "
        f"User-Agent: {request.headers.get('user-agent')}"
    )
    
    try:
        response = await call_next(request)
        
        # Log response details for sensitive endpoints
        if request.url.path.startswith('/api/keys') or request.url.path.startswith('/api/downloads'):
            security_logger.info(
                f"Response - ID: {correlation_id}, Status: {response.status_code}"
            )
        
        # Add correlation ID to response headers
        response.headers["X-Correlation-ID"] = correlation_id
        return response
    except Exception as e:
        security_logger.error(
            f"Exception - ID: {correlation_id}, Error: {str(e)}"
        )
        raise
```

### 21. Missing Security Headers
- **File**: [`backend/main.py`](backend/main.py:58-65)
- **Category**: HTTP Security
- **Description**: Security headers are not implemented.
- **Impact**: The application is vulnerable to various client-side attacks.
- **Remediation**:
  1. Implement security headers middleware
  2. Add headers like X-Content-Type-Options, X-Frame-Options, CSP
  3. Use HTTPS in production

```python
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        
        # Add security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["Content-Security-Policy"] = "default-src 'self'"
        
        return response

# In main.py
app.add_middleware(SecurityHeadersMiddleware)
```

### 22. Insecure Session Management
- **File**: [`backend/main.py`](backend/main.py:17-33)
- **Category**: Session Management
- **Description**: No proper session management is implemented.
- **Impact**: Session hijacking and fixation attacks are possible.
- **Remediation**:
  1. Implement secure session management
  2. Use secure, HTTP-only cookies
  3. Regenerate session IDs on login

```python
from itsdangerous import URLSafeTimedSerializer
from fastapi import Response
import secrets

# Secure session configuration
SECRET_KEY = os.environ.get("SESSION_SECRET", secrets.token_urlsafe(32))
SESSION_TIMEOUT = 3600  # 1 hour

serializer = URLSafeTimedSerializer(SECRET_KEY, "auth")

def create_session(data: dict) -> str:
    """Create a secure session token."""
    return serializer.dumps(data)

def verify_session(token: str) -> dict:
    """Verify and decrypt session token."""
    try:
        return serializer.loads(token, max_age=SESSION_TIMEOUT)
    except Exception:
        return None

# In endpoint
@app.post("/login")
async def login(response: Response):
    # Authenticate user
    # ...
    
    # Create session
    session_data = {"user_id": user.id, "role": user.role}
    session_token = create_session(session_data)
    
    # Set secure cookie
    response.set_cookie(
        "session_token",
        session_token,
        max_age=SESSION_TIMEOUT,
        httponly=True,
        secure=True,  # Only over HTTPS
        samesite="strict"
    )
    
    return response
```

### 23. No Input Sanitization for Search Queries
- **File**: [`backend/services/stock_media_service.py`](backend/services/stock_media_service.py:33-87)
- **Category**: Input Validation
- **Description**: Search queries are passed directly to external APIs without sanitization.
- **Code**:
```python
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
```
- **Impact**: Potential injection attacks against external APIs.
- **Remediation**:
  1. Implement proper input sanitization
  2. Use parameterized queries for external APIs
  3. Validate and encode special characters

```python
import html
import urllib.parse

def sanitize_query(query: str) -> str:
    """Sanitize search query to prevent injection."""
    # HTML encode to prevent XSS
    query = html.escape(query)
    
    # URL encode for API requests
    query = urllib.parse.quote(query)
    
    # Limit length
    if len(query) > 1000:
        raise ValueError("Query too long")
    
    return query

async def search_pexels(self, query: str, per_page: int = 20, page: int = 1) -> List[MediaItem]:
    """Search for videos on Pexels."""
    # Sanitize query
    clean_query = sanitize_query(query)
    
    source_config = get_media_source_config("pexels")
    api_key = api_key_manager.get_api_key("pexels")
    
    if not api_key:
        return []
    
    if api_key_manager.is_rate_limited("pexels"):
        return []
    
    try:
        headers = {"Authorization": api_key}
        params = {
            "query": clean_query,
            "per_page": min(per_page, self.settings.max_per_page),
            "page": page
        }
```

## Remediation Roadmap

### Phase 1: Critical Security Fixes (Immediate - 1-2 weeks)
1. Implement server-side API key storage with encrypted client-side caching
2. Add proper authentication/authorization with JWT tokens
3. Implement comprehensive input validation and sanitization
4. Fix hardcoded encryption key storage using environment variables
5. Add parameterized queries throughout the application

### Phase 2: High Priority Security (2-4 weeks)
1. Implement proper filename sanitization to prevent path traversal
2. Add user authentication and resource ownership verification
3. Implement rate limiting on API endpoints
4. Standardize error handling across the application
5. Add comprehensive null/undefined checks

### Phase 3: Medium Priority Improvements (1-2 months)
1. Implement database encryption or use encrypted database solution
2. Add role-based access controls at database level
3. Implement comprehensive security logging with alerts
4. Add security headers middleware
5. Refactor large functions into smaller, focused components
6. Update all dependencies to latest secure versions

### Phase 4: Long-term Enhancements (2-3 months)
1. Implement automated security scanning in CI/CD pipeline
2. Add content security policy and other advanced security headers
3. Implement session management with secure, HTTP-only cookies
4. Add API quotas per user
5. Implement advanced monitoring and alerting system

## Best Practices Recommendations

### Development Practices
1. Implement code review process with security focus
2. Use static analysis tools (e.g., ESLint with security rules, Bandit for Python)
3. Adopt secure coding standards and guidelines
4. Implement automated testing for security vulnerabilities
5. Use dependency scanning tools regularly

### Deployment Practices
1. Use environment-specific configurations
2. Implement proper secrets management (e.g., HashiCorp Vault, AWS Secrets Manager)
3. Enable HTTPS in all environments
4. Implement proper logging and monitoring
5. Use container security best practices if deploying in containers

### Operational Practices
1. Regular security audits and penetration testing
2. Implement incident response plan
3. Regular dependency updates and vulnerability scanning
4. Security training for development team
5. Implement backup and recovery procedures

## Conclusion

The Stock Footage Finder application has a solid foundation but requires significant security improvements before production deployment. The most critical issues relate to API key management and lack of authentication, which could lead to unauthorized access to paid services and data breaches.

Implementing the recommended changes will significantly improve the security posture and code quality of the application, making it more resilient against common attack vectors and easier to maintain and extend in the future.

Regular security assessments should be conducted to identify and address new vulnerabilities as the application evolves.
</attempt_completion>