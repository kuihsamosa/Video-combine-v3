import React, { useState, useEffect } from 'react';
import {
  Play,
  Download as DownloadIcon,
  Heart,
  ExternalLink,
  Eye,
  Clock,
  Image as ImageIcon,
  Video,
  Pause,
  X,
  RotateCcw
} from 'lucide-react';
import { storageService } from '../services/storageService';
import { downloadService } from '../services/downloadService';
import type { MediaItem, Download } from '../types';

interface MediaCardProps {
  mediaItem: MediaItem;
  onPreview?: (mediaItem: MediaItem) => void;
  onDownload?: (mediaItem: MediaItem) => void;
  showSource?: boolean;
  compact?: boolean;
}

export function MediaCard({
  mediaItem,
  onPreview,
  onDownload,
  showSource = true,
  compact = false,
}: MediaCardProps) {
  const [isFavorite, setIsFavorite] = useState(() =>
    storageService.isFavorite(mediaItem.id)
  );
  const [download, setDownload] = useState<Download | null>(null);
  const [imageError, setImageError] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);

  const isVideo = mediaItem.url.includes('video') || mediaItem.duration;

  // Check for existing download on component mount
  useEffect(() => {
    const checkExistingDownload = async () => {
      try {
        const downloads = await downloadService.getDownloads();
        const existingDownload = downloads.downloads.find(
          d => d.media_id === mediaItem.id && d.media_source === mediaItem.source.name
        );
        
        if (existingDownload) {
          setDownload(existingDownload);
          
          // If download is active, start polling for updates
          if (['pending', 'downloading', 'paused'].includes(existingDownload.status)) {
            const stopPolling = await downloadService.pollDownloadUpdates(
              existingDownload.id,
              (updatedDownload) => setDownload(updatedDownload)
            );
            
            return () => stopPolling();
          }
        }
      } catch (error) {
        console.error('Error checking existing download:', error);
      }
    };

    checkExistingDownload();
  }, [mediaItem.id, mediaItem.source.name]);

  const handlePreview = () => {
    if (onPreview) {
      onPreview(mediaItem);
    }
  };

  const handleDownload = async () => {
    try {
      // If there's a specific download URL, use it
      const downloadUrl = mediaItem.downloadUrl || mediaItem.url;
      
      // Generate filename from title or URL
      const filename = mediaItem.title
        ? `${mediaItem.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${isVideo ? 'mp4' : 'jpg'}`
        : downloadUrl.split('/').pop() || `media_${mediaItem.id}.${isVideo ? 'mp4' : 'jpg'}`;

      const newDownload = await downloadService.startDownload({
        media_id: mediaItem.id,
        media_url: downloadUrl,
        media_title: mediaItem.title || 'Untitled',
        media_source: mediaItem.source.name,
        media_type: isVideo ? 'video' : 'image'
      });
      
      setDownload(newDownload);
      
      // Start polling for updates
      const stopPolling = await downloadService.pollDownloadUpdates(
        newDownload.id,
        (updatedDownload) => setDownload(updatedDownload)
      );
      
      if (onDownload) {
        onDownload(mediaItem);
      }
    } catch (error) {
      console.error('Download failed:', error);
    }
  };

  const handlePauseDownload = async () => {
    if (!download) return;
    
    try {
      const updatedDownload = await downloadService.pauseDownload(download.id);
      setDownload(updatedDownload);
    } catch (error) {
      console.error('Error pausing download:', error);
    }
  };

  const handleResumeDownload = async () => {
    if (!download) return;
    
    try {
      const updatedDownload = await downloadService.resumeDownload(download.id);
      setDownload(updatedDownload);
    } catch (error) {
      console.error('Error resuming download:', error);
    }
  };

  const handleCancelDownload = async () => {
    if (!download) return;
    
    try {
      await downloadService.cancelDownload(download.id);
      setDownload(null);
      setShowDownloadMenu(false);
    } catch (error) {
      console.error('Error cancelling download:', error);
    }
  };

  const handleRetryDownload = async () => {
    if (!download) return;
    
    try {
      const updatedDownload = await downloadService.retryDownload(download.id);
      setDownload(updatedDownload);
    } catch (error) {
      console.error('Error retrying download:', error);
    }
  };

  const handleFavoriteToggle = () => {
    if (isFavorite) {
      storageService.removeFavorite(mediaItem.id);
      setIsFavorite(false);
    } else {
      storageService.addFavorite(mediaItem);
      setIsFavorite(true);
    }
  };

  const handleImageError = () => {
    setImageError(true);
  };

  const formatDuration = (seconds?: number): string => {
    if (!seconds) return '';
    
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return '';
    
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const cardClassName = [
    'media-card',
    compact && 'media-card--compact',
    isVideo && 'media-card--video',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClassName}>
      <div className="media-card__thumbnail-container">
        {imageError ? (
          <div className="media-card__error-placeholder">
            <ImageIcon size={24} />
            <span>Image not available</span>
          </div>
        ) : (
          <img
            src={mediaItem.previewUrl || mediaItem.url}
            alt={mediaItem.title || 'Media thumbnail'}
            className="media-card__thumbnail"
            onError={handleImageError}
            loading="lazy"
          />
        )}
        
        {isVideo && (
          <button
            onClick={handlePreview}
            className="media-card__play-button"
            aria-label="Preview video"
          >
            <Play size={20} />
          </button>
        )}

        <div className="media-card__overlay">
          <div className="media-card__actions">
            <button
              onClick={handlePreview}
              className="media-card__action-button"
              aria-label="Preview"
            >
              <Eye size={16} />
            </button>
            
            <button
              onClick={handleFavoriteToggle}
              className={`media-card__action-button ${isFavorite ? 'media-card__action-button--favorite' : ''}`}
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Heart size={16} fill={isFavorite ? 'currentColor' : 'none'} />
            </button>
            
            <div className="media-card__download-container">
              <button
                onClick={() => {
                  if (download) {
                    setShowDownloadMenu(!showDownloadMenu);
                  } else {
                    handleDownload();
                  }
                }}
                className="media-card__action-button"
                aria-label="Download"
                style={{
                  backgroundColor: download ? downloadService.getStatusColor(download.status) : undefined
                }}
              >
                {download ? (
                  <span className="media-card__download-icon">
                    {downloadService.getStatusIcon(download.status)}
                  </span>
                ) : (
                  <DownloadIcon size={16} />
                )}
              </button>
              
              {download && showDownloadMenu && (
                <div className="media-card__download-menu">
                  <div className="media-card__download-info">
                    <div className="media-card__download-status">
                      Status: {download.status}
                    </div>
                    {download.progress > 0 && (
                      <div className="media-card__download-progress">
                        <div className="media-card__download-progress-bar">
                          <div
                            className="media-card__download-progress-fill"
                            style={{ width: `${download.progress}%` }}
                          />
                        </div>
                        <span className="media-card__download-progress-text">
                          {download.progress.toFixed(1)}%
                        </span>
                      </div>
                    )}
                    {download.download_speed && (
                      <div className="media-card__download-speed">
                        {downloadService.formatDownloadSpeed(download.download_speed)}
                      </div>
                    )}
                    {download.eta_seconds && (
                      <div className="media-card__download-eta">
                        ETA: {downloadService.formatETA(download.eta_seconds)}
                      </div>
                    )}
                  </div>
                  
                  <div className="media-card__download-actions">
                    {download.status === 'downloading' && (
                      <button
                        onClick={handlePauseDownload}
                        className="media-card__download-action-button"
                        aria-label="Pause download"
                      >
                        <Pause size={14} />
                        Pause
                      </button>
                    )}
                    
                    {download.status === 'paused' && (
                      <button
                        onClick={handleResumeDownload}
                        className="media-card__download-action-button"
                        aria-label="Resume download"
                      >
                        <Play size={14} />
                        Resume
                      </button>
                    )}
                    
                    {download.status === 'failed' && (
                      <button
                        onClick={handleRetryDownload}
                        className="media-card__download-action-button"
                        aria-label="Retry download"
                      >
                        <RotateCcw size={14} />
                        Retry
                      </button>
                    )}
                    
                    {['pending', 'downloading', 'paused', 'failed'].includes(download.status) && (
                      <button
                        onClick={handleCancelDownload}
                        className="media-card__download-action-button media-card__download-action-button--danger"
                        aria-label="Cancel download"
                      >
                        <X size={14} />
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="media-card__content">
        <h3 className="media-card__title" title={mediaItem.title}>
          {mediaItem.title || 'Untitled'}
        </h3>
        
        {mediaItem.description && !compact && (
          <p className="media-card__description" title={mediaItem.description}>
            {mediaItem.description}
          </p>
        )}

        <div className="media-card__metadata">
          {isVideo && mediaItem.duration && (
            <div className="media-card__metadata-item">
              <Clock size={12} />
              <span>{formatDuration(mediaItem.duration)}</span>
            </div>
          )}
          
          {mediaItem.fileSize && (
            <div className="media-card__metadata-item">
              <DownloadIcon size={12} />
              <span>{formatFileSize(mediaItem.fileSize)}</span>
            </div>
          )}
          
          {mediaItem.width && mediaItem.height && (
            <div className="media-card__metadata-item">
              <span>{mediaItem.width} × {mediaItem.height}</span>
            </div>
          )}
          
          <div className="media-card__metadata-item">
            {isVideo ? <Video size={12} /> : <ImageIcon size={12} />}
            <span>{isVideo ? 'Video' : 'Image'}</span>
          </div>
        </div>

        {showSource && (
          <div className="media-card__source">
            <span className="media-card__source-label">Source:</span>
            <span className="media-card__source-name">{mediaItem.source.displayName}</span>
            {mediaItem.author && (
              <span className="media-card__author">
                by {mediaItem.author}
              </span>
            )}
          </div>
        )}

        {mediaItem.tags && mediaItem.tags.length > 0 && !compact && (
          <div className="media-card__tags">
            {mediaItem.tags.slice(0, 3).map((tag, index) => (
              <span key={index} className="media-card__tag">
                {tag}
              </span>
            ))}
            {mediaItem.tags.length > 3 && (
              <span className="media-card__tag media-card__tag--more">
                +{mediaItem.tags.length - 3}
              </span>
            )}
          </div>
        )}

        {mediaItem.authorUrl && (
          <a
            href={mediaItem.authorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="media-card__author-link"
            aria-label="View author profile"
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

export default MediaCard;