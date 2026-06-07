"""
Media types and classes for stock footage finder.
"""

from typing import Dict, List, Optional, Any


class MediaItem:
    """Standardized media item representation across all sources."""
    
    def __init__(
        self,
        id: str,
        title: str,
        url: str,
        source: str,
        description: Optional[str] = None,
        preview_url: Optional[str] = None,
        download_url: Optional[str] = None,
        duration: Optional[int] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        file_size: Optional[int] = None,
        tags: Optional[List[str]] = None,
        license: Optional[str] = None,
        author: Optional[str] = None,
        author_url: Optional[str] = None,
        media_type: str = "video"
    ):
        self.id = id
        self.title = title
        self.description = description
        self.url = url
        self.preview_url = preview_url
        self.download_url = download_url
        self.duration = duration
        self.width = width
        self.height = height
        self.file_size = file_size
        self.tags = tags or []
        self.source = source
        self.license = license
        self.author = author
        self.author_url = author_url
        self.media_type = media_type
        # New attributes for relevance scoring
        self.relevance_score = None
        self.component_scores = None
    
    def to_dict(self, relevance_score: Optional[float] = None, 
                component_scores: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        """Convert to dictionary representation."""
        result = {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "url": self.url,
            "previewUrl": self.preview_url,
            "downloadUrl": self.download_url,
            "duration": self.duration,
            "width": self.width,
            "height": self.height,
            "fileSize": self.file_size,
            "tags": self.tags,
            "source": self.source,
            "license": self.license,
            "author": self.author,
            "authorUrl": self.author_url,
            "mediaType": self.media_type
        }
        
        if relevance_score is not None:
            result["relevanceScore"] = relevance_score
        
        if component_scores:
            result["componentScores"] = component_scores
        
        return result