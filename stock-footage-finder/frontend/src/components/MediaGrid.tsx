import React, { useState, useEffect, useRef } from 'react';
import { Grid, List, Download, Heart, Eye } from 'lucide-react';
import MediaCard from './MediaCard';
import type { MediaItem, SearchResult } from '../types';

interface MediaGridProps {
  results: SearchResult[];
  isLoading?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onPreview?: (mediaItem: MediaItem) => void;
  onDownload?: (mediaItem: MediaItem) => void;
  compact?: boolean;
  showSource?: boolean;
}

type ViewMode = 'grid' | 'list';

export function MediaGrid({
  results,
  isLoading = false,
  onLoadMore,
  hasMore = false,
  onPreview,
  onDownload,
  compact = false,
  showSource = true,
}: MediaGridProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [showBulkActions, setShowBulkActions] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Flatten all media items from all search results
  const allMediaItems = results.flatMap(result => result.results);

  // Setup intersection observer for infinite scroll
  useEffect(() => {
    if (!loadMoreRef.current || !onLoadMore) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && hasMore && !isLoading) {
          onLoadMore();
        }
      },
      {
        threshold: 0.1,
        rootMargin: '200px',
      }
    );

    observerRef.current.observe(loadMoreRef.current);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [onLoadMore, hasMore, isLoading]);

  // Handle bulk selection
  const handleItemSelect = (mediaId: string, isSelected: boolean) => {
    setSelectedItems(prev => {
      const newSet = new Set(prev);
      if (isSelected) {
        newSet.add(mediaId);
      } else {
        newSet.delete(mediaId);
      }
      
      setShowBulkActions(newSet.size > 0);
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedItems.size === allMediaItems.length) {
      setSelectedItems(new Set());
      setShowBulkActions(false);
    } else {
      const allIds = new Set(allMediaItems.map(item => item.id));
      setSelectedItems(allIds);
      setShowBulkActions(true);
    }
  };

  const handleClearSelection = () => {
    setSelectedItems(new Set());
    setShowBulkActions(false);
  };

  const handleBulkDownload = async () => {
    const selectedMedia = allMediaItems.filter(item => selectedItems.has(item.id));
    
    for (const media of selectedMedia) {
      try {
        if (onDownload) {
          onDownload(media);
        }
      } catch (error) {
        console.error(`Failed to download ${media.id}:`, error);
      }
    }
    
    handleClearSelection();
  };

  const handleBulkFavorite = () => {
    const selectedMedia = allMediaItems.filter(item => selectedItems.has(item.id));
    
    selectedMedia.forEach(media => {
      // This would need to be implemented in storageService
      console.log('Toggle favorite for:', media.id);
    });
    
    handleClearSelection();
  };

  const renderBulkActions = () => {
    if (!showBulkActions) return null;

    return (
      <div className="media-grid__bulk-actions">
        <span className="media-grid__selection-count">
          {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''} selected
        </span>
        
        <button
          onClick={handleClearSelection}
          className="media-grid__bulk-action media-grid__bulk-action--clear"
        >
          Clear
        </button>
        
        <button
          onClick={handleBulkDownload}
          className="media-grid__bulk-action media-grid__bulk-action--download"
        >
          <Download size={16} />
          Download
        </button>
        
        <button
          onClick={handleBulkFavorite}
          className="media-grid__bulk-action media-grid__bulk-action--favorite"
        >
          <Heart size={16} />
          Favorite
        </button>
      </div>
    );
  };

  const renderEmptyState = () => {
    if (results.length === 0 && !isLoading) {
      return (
        <div className="media-grid__empty">
          <div className="media-grid__empty-icon">
            <Eye size={48} />
          </div>
          <h3 className="media-grid__empty-title">No results found</h3>
          <p className="media-grid__empty-description">
            Try adjusting your search terms or filters to find what you're looking for.
          </p>
        </div>
      );
    }
    return null;
  };

  const renderLoadingState = () => {
    if (!isLoading) return null;

    return (
      <div className="media-grid__loading">
        <div className="media-grid__loading-spinner" />
        <p>Searching for media...</p>
      </div>
    );
  };

  const renderLoadMoreTrigger = () => {
    if (!hasMore || isLoading) return null;

    return (
      <div ref={loadMoreRef} className="media-grid__load-more">
        <div className="media-grid__load-more-spinner" />
        <p>Loading more results...</p>
      </div>
    );
  };

  const gridClassName = [
    'media-grid',
    `media-grid--${viewMode}`,
    compact && 'media-grid--compact',
  ].filter(Boolean).join(' ');

  return (
    <div className="media-grid-container">
      {/* Header with view controls */}
      <div className="media-grid__header">
        <div className="media-grid__info">
          <span className="media-grid__result-count">
            {allMediaItems.length} result{allMediaItems.length !== 1 ? 's' : ''}
          </span>
          
          {results.length > 0 && (
            <span className="media-grid__source-info">
              from {results.length} source{results.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="media-grid__controls">
          <button
            onClick={handleSelectAll}
            className="media-grid__control-button"
            disabled={allMediaItems.length === 0}
          >
            {selectedItems.size === allMediaItems.length ? 'Deselect All' : 'Select All'}
          </button>

          <div className="media-grid__view-controls">
            <button
              onClick={() => setViewMode('grid')}
              className={`media-grid__view-button ${viewMode === 'grid' ? 'media-grid__view-button--active' : ''}`}
              aria-label="Grid view"
            >
              <Grid size={18} />
            </button>
            
            <button
              onClick={() => setViewMode('list')}
              className={`media-grid__view-button ${viewMode === 'list' ? 'media-grid__view-button--active' : ''}`}
              aria-label="List view"
            >
              <List size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Bulk actions */}
      {renderBulkActions()}

      {/* Empty state */}
      {renderEmptyState()}

      {/* Media items */}
      {allMediaItems.length > 0 && (
        <div className={gridClassName}>
          {allMediaItems.map((mediaItem) => (
            <div key={mediaItem.id} className="media-grid__item">
              <MediaCard
                mediaItem={mediaItem}
                onPreview={onPreview}
                onDownload={onDownload}
                compact={compact}
                showSource={showSource}
              />
              
              {/* Checkbox for bulk selection */}
              <div className="media-grid__item-checkbox">
                <input
                  type="checkbox"
                  checked={selectedItems.has(mediaItem.id)}
                  onChange={(e) => handleItemSelect(mediaItem.id, e.target.checked)}
                  className="media-grid__checkbox"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Loading state */}
      {renderLoadingState()}

      {/* Load more trigger */}
      {renderLoadMoreTrigger()}
    </div>
  );
}

export default MediaGrid;