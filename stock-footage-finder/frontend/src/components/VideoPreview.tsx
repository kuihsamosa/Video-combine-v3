import React, { useState, useEffect, useRef } from 'react';
import { X, Download, Share2, Heart, ExternalLink, Volume2, VolumeX } from 'lucide-react';
import { storageService } from '../services/storageService';
import { downloadService } from '../services/downloadService';
import type { MediaItem } from '../types';

interface VideoPreviewProps {
  mediaItem: MediaItem | null;
  isOpen: boolean;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
}

export function VideoPreview({
  mediaItem,
  isOpen,
  onClose,
  onNext,
  onPrevious,
}: VideoPreviewProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (mediaItem) {
      setIsFavorite(storageService.isFavorite(mediaItem.id));
      setError(null);
      setIsPlaying(false);
    }
  }, [mediaItem]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || !mediaItem) return;

      switch (e.key) {
        case 'ArrowLeft':
          if (onPrevious) {
            onPrevious();
          }
          break;
        case 'ArrowRight':
          if (onNext) {
            onNext();
          }
          break;
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'm':
          toggleMute();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, mediaItem, onNext, onPrevious, onClose]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
    }
  }, [isMuted]);

  const togglePlay = () => {
    if (!videoRef.current) return;

    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play().catch(err => {
        setError('Failed to play video');
        console.error('Video play error:', err);
      });
    }
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const handleDownload = async () => {
    if (!mediaItem || isDownloading) return;

    setIsDownloading(true);
    try {
      const downloadUrl = mediaItem.downloadUrl || mediaItem.url;
      const filename = mediaItem.title 
        ? `${mediaItem.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.mp4`
        : downloadUrl.split('/').pop() || `video_${mediaItem.id}.mp4`;

      await downloadService.downloadFile(downloadUrl, filename);
    } catch (error) {
      console.error('Download failed:', error);
      setError('Failed to download video');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleFavoriteToggle = () => {
    if (!mediaItem) return;

    if (isFavorite) {
      storageService.removeFavorite(mediaItem.id);
      setIsFavorite(false);
    } else {
      storageService.addFavorite(mediaItem);
      setIsFavorite(true);
    }
  };

  const handleShare = async () => {
    if (!mediaItem) return;

    try {
      if (navigator.share) {
        await navigator.share({
          title: mediaItem.title || 'Check out this video',
          text: mediaItem.description,
          url: mediaItem.url,
        });
      } else {
        // Fallback: copy to clipboard
        await navigator.clipboard.writeText(mediaItem.url);
        // Could show a toast notification here
      }
    } catch (error) {
      console.error('Share failed:', error);
    }
  };

  const formatDuration = (seconds?: number): string => {
    if (!seconds) return '00:00';
    
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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

  if (!isOpen || !mediaItem) {
    return null;
  }

  return (
    <div className="video-preview" onClick={onClose}>
      <div className="video-preview__content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="video-preview__header">
          <h2 className="video-preview__title">
            {mediaItem.title || 'Untitled Video'}
          </h2>
          
          <button
            onClick={onClose}
            className="video-preview__close-button"
            aria-label="Close preview"
          >
            <X size={24} />
          </button>
        </div>

        {/* Video Container */}
        <div className="video-preview__video-container">
          {error ? (
            <div className="video-preview__error">
              <p>{error}</p>
              <button onClick={() => setError(null)} className="video-preview__retry-button">
                Retry
              </button>
            </div>
          ) : (
            <video
              ref={videoRef}
              src={mediaItem.url}
              className="video-preview__video"
              controls={false}
              loop
              playsInline
              onClick={togglePlay}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          )}

          {/* Video Controls Overlay */}
          <div className="video-preview__controls">
            <button
              onClick={togglePlay}
              className="video-preview__control-button video-preview__play-button"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <div className="video-preview__pause-icon">❚❚</div>
              ) : (
                <div className="video-preview__play-icon">▶</div>
              )}
            </button>

            <button
              onClick={toggleMute}
              className="video-preview__control-button"
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
          </div>

          {/* Navigation */}
          {onPrevious && (
            <button
              onClick={onPrevious}
              className="video-preview__nav video-preview__nav--previous"
              aria-label="Previous video"
            >
              ‹
            </button>
          )}

          {onNext && (
            <button
              onClick={onNext}
              className="video-preview__nav video-preview__nav--next"
              aria-label="Next video"
            >
              ›
            </button>
          )}
        </div>

        {/* Video Info */}
        <div className="video-preview__info">
          {mediaItem.description && (
            <p className="video-preview__description">
              {mediaItem.description}
            </p>
          )}

          <div className="video-preview__metadata">
            {mediaItem.duration && (
              <div className="video-preview__metadata-item">
                <span>Duration:</span>
                <span>{formatDuration(mediaItem.duration)}</span>
              </div>
            )}

            {mediaItem.width && mediaItem.height && (
              <div className="video-preview__metadata-item">
                <span>Resolution:</span>
                <span>{mediaItem.width} × {mediaItem.height}</span>
              </div>
            )}

            {mediaItem.fileSize && (
              <div className="video-preview__metadata-item">
                <span>Size:</span>
                <span>{formatFileSize(mediaItem.fileSize)}</span>
              </div>
            )}

            <div className="video-preview__metadata-item">
              <span>Source:</span>
              <span>{mediaItem.source.displayName}</span>
            </div>

            {mediaItem.author && (
              <div className="video-preview__metadata-item">
                <span>Author:</span>
                <span>{mediaItem.author}</span>
              </div>
            )}

            {mediaItem.license && (
              <div className="video-preview__metadata-item">
                <span>License:</span>
                <span>{mediaItem.license}</span>
              </div>
            )}
          </div>

          {/* Tags */}
          {mediaItem.tags && mediaItem.tags.length > 0 && (
            <div className="video-preview__tags">
              {mediaItem.tags.map((tag, index) => (
                <span key={index} className="video-preview__tag">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          <div className="video-preview__actions">
            <button
              onClick={handleFavoriteToggle}
              className={`video-preview__action-button ${isFavorite ? 'video-preview__action-button--favorite' : ''}`}
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Heart size={18} fill={isFavorite ? 'currentColor' : 'none'} />
              <span>{isFavorite ? 'Favorited' : 'Favorite'}</span>
            </button>

            <button
              onClick={handleDownload}
              className="video-preview__action-button"
              aria-label="Download video"
              disabled={isDownloading}
            >
              {isDownloading ? (
                <div className="video-preview__spinner" />
              ) : (
                <Download size={18} />
              )}
              <span>{isDownloading ? 'Downloading...' : 'Download'}</span>
            </button>

            <button
              onClick={handleShare}
              className="video-preview__action-button"
              aria-label="Share video"
            >
              <Share2 size={18} />
              <span>Share</span>
            </button>

            {mediaItem.authorUrl && (
              <a
                href={mediaItem.authorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="video-preview__action-button video-preview__action-button--external"
                aria-label="View author profile"
              >
                <ExternalLink size={18} />
                <span>Author</span>
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default VideoPreview;